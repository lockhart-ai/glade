import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BridgeErrorCode, type GladeEvent } from '../../shared/bridge'
import { PauseReason, TaskActivity, type Task, type TaskPause } from '../../shared/domain'
import { getTask, updateTask } from '../db/repositories/tasks'
import { listMessages } from '../db/repositories/messages'
import { listToolEvents } from '../db/repositories/tool-events'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setOpenRouterChoice, setOpenRouterConnection } from '../db/repositories/openrouter'
import { updateSettings } from '../db/repositories/settings'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { FakeAgentBackend, settle } from './fake-backend'
import { createAgentRunner, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let backend: FakeAgentBackend
let runner: AgentRunner
let task: Task
let events: GladeEvent[]
const pause: TaskPause = {
  reason: PauseReason.UsageLimit,
  since: 100,
  resumesAt: Date.now() + 3600_000,
  checks: 0,
  details: 'Subscription limit reached',
}

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('ciphertext'),
    models: [SAMPLE_MODEL],
    providers: [SAMPLE_PROVIDER],
  })
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
  backend = new FakeAgentBackend()
  events = []
  runner = createAgentRunner({ db: database.db, backend, emit: (event) => events.push(event) })
})
afterEach(() => {
  runner.close()
  database.close()
})

async function previousTurn(): Promise<void> {
  runner.send(task.id, 'Read the sample file and remember its contents.')
  backend.session.emit(sdk.init())
  backend.session.emit(sdk.toolUse('read-1', 'Read', { file_path: '/code/sample.ts' }))
  backend.session.emit(sdk.toolResult('read-1', 'export const answer = 42'))
  backend.session.emit(sdk.result('The answer is 42.'))
  await settle()
}

it('continues the same limit-paused task on OpenRouter without rewriting chat, calls or queued input', async () => {
  await previousTurn()
  const old = backend.session
  const history = listMessages(database.db, task.id)
  const calls = listToolEvents(database.db, task.id)
  updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
  runner.queue(task.id, 'Also check its tests.')
  const changed = await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  expect(changed).toMatchObject({ id: task.id, model: SAMPLE_CHOICE.id, pause })
  expect(old.closed).toBe(true)
  expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
  expect(listMessages(database.db, task.id)).toEqual(history)
  expect(listQueuedMessages(database.db, task.id)).toHaveLength(1)
  expect(listToolEvents(database.db, task.id).slice(0, calls.length)).toEqual(calls)
  expect(listToolEvents(database.db, task.id).at(-1)).toMatchObject({
    text: 'Switched model to Sample Flash · Sample Host (OpenRouter)',
  })
  runner.retry(task.id)
  expect(backend.session.sent.at(-1)?.settings.model).toBe(SAMPLE_CHOICE.id)
  expect(getTask(database.db, task.id)?.pause).toBeNull()
  backend.session.emit(sdk.init())
  backend.session.emit(sdk.result('The tests match.'))
  await settle()
  expect(
    listToolEvents(database.db, task.id).filter((event) => 'text' in event && event.text.startsWith('Switched model')),
  ).toHaveLength(1)
})

it('holds input until readiness and rolls back a failed destination without a success entry', async () => {
  await previousTurn()
  const old = backend.session
  updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
  let reject: (error: Error) => void = () => undefined
  backend.onSessionStart = (session) => {
    Object.assign(session, {
      ready: () =>
        new Promise<void>((_, fail) => {
          reject = fail
        }),
    })
  }
  const switchAttempt = runner.changeModel(task.id, SAMPLE_CHOICE.id)
  await settle()
  expect(getTask(database.db, task.id)?.model).toBe(task.model)
  expect(() => runner.send(task.id, 'Continue')).toThrow('switching models')
  runner.queue(task.id, 'Keep this message.')
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
  expect(() => runner.retry(task.id)).toThrow('switching models')
  reject(new Error('History could not be loaded'))
  await expect(switchAttempt).rejects.toThrow('History could not be loaded')
  expect(old.closed).toBe(false)
  expect(backend.session.closed).toBe(true)
  expect(getTask(database.db, task.id)).toMatchObject({ model: task.model, pause })
  expect(listQueuedMessages(database.db, task.id)).toHaveLength(1)
  expect(
    listToolEvents(database.db, task.id).some((event) => 'text' in event && event.text.startsWith('Switched model')),
  ).toBe(false)
})

it('revokes a provisional session on app close before it can change the task', async () => {
  await previousTurn()
  let ready: () => void = () => undefined
  backend.onSessionStart = (session) => {
    Object.assign(session, {
      ready: () =>
        new Promise<void>((resolve) => {
          ready = resolve
        }),
    })
  }
  const switching = runner.changeModel(task.id, SAMPLE_CHOICE.id)
  await settle()
  runner.close()
  expect(backend.session.closed).toBe(true)
  ready()
  await expect(switching).rejects.toThrow('task closed')
  expect(getTask(database.db, task.id)?.model).toBe(task.model)
})

it('keeps the original session when a provisional sandbox overlay fails', async () => {
  await previousTurn()
  const original = backend.session
  updateSettings(database.db, { sandboxEnabled: true })
  backend.onSessionStart = (session) => {
    session.onApplyFlagSettings = () => Promise.reject(new Error('Overlay rejected'))
  }
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toThrow('sandbox settings')
  expect(original.closed).toBe(false)
  expect(getTask(database.db, task.id)?.model).toBe(task.model)
})

it('records an ordinary model switch only after its configure promise succeeds and rolls back a refusal', async () => {
  await previousTurn()
  const session = backend.session
  let finish: () => void = () => undefined
  Object.assign(session, {
    configure: () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  })
  await runner.changeModel(task.id, 'claude-sonnet-5')
  runner.send(task.id, 'Continue')
  expect(
    listToolEvents(database.db, task.id).some((event) => 'text' in event && event.text.startsWith('Switched model')),
  ).toBe(false)
  finish()
  await settle()
  expect(listToolEvents(database.db, task.id).at(-1)).toMatchObject({
    text: 'Switched model to Sonnet 5 (Anthropic account)',
  })
  session.emit(sdk.result('Done.'))
  await settle()
  Object.assign(session, { configure: () => Promise.reject(new Error('Model refused')) })
  await runner.changeModel(task.id, 'claude-haiku-4-5')
  runner.send(task.id, 'Continue again')
  await settle()
  expect(getTask(database.db, task.id)?.model).toBe('claude-sonnet-5')
  expect(
    listToolEvents(database.db, task.id).filter((event) => 'text' in event && event.text.startsWith('Switched model')),
  ).toHaveLength(1)
})

it('rejects unsafe, unavailable and mixed-source switches; first-turn selection starts no process', async () => {
  await expect(runner.changeModel('missing', SAMPLE_CHOICE.id)).rejects.toMatchObject({
    code: BridgeErrorCode.NotFound,
  })
  expect((await runner.changeModel(task.id, task.model)).model).toBe(task.model)
  await expect(runner.changeModel(task.id, task.model, SAMPLE_CHOICE.id)).rejects.toThrow('must use')
  expect((await runner.changeModel(task.id, SAMPLE_CHOICE.id)).model).toBe(SAMPLE_CHOICE.id)
  expect(backend.sessions).toHaveLength(0)
  await runner.changeModel(task.id, 'claude-sonnet-5')
  runner.send(task.id, 'Start')
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
  expect(() => runner.retry(task.id, SAMPLE_CHOICE.id)).toThrow('Select the new model')
  setOpenRouterChoice(database.db, { ...SAMPLE_CHOICE, enabled: false })
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toThrow('Enable this')
})

it('restarts at a safe boundary for a same-source child model and delivers waiting queued input after readiness', async () => {
  await previousTurn()
  const old = backend.session
  let ready: () => void = () => undefined
  backend.onSessionStart = (session) => {
    Object.assign(session, {
      ready: () =>
        new Promise<void>((resolve) => {
          ready = resolve
        }),
    })
  }
  const switching = runner.changeModel(task.id, task.model, 'claude-haiku-4-5')
  await settle()
  runner.queue(task.id, 'Continue in the saved context.')
  expect(backend.session.sent).toHaveLength(0)
  ready()
  await switching
  expect(old.closed).toBe(true)
  expect(backend.session.options.subagentModel).toBe('claude-haiku-4-5')
  expect(backend.session.sent.at(-1)?.text).toContain('Continue in the saved context.')
  expect(listQueuedMessages(database.db, task.id)).toHaveLength(0)
})

it('ignores OpenRouter account readings, rate limits, fake SDK windows and list-price cost', async () => {
  const account = { accountRead: vi.fn(), usageRead: vi.fn(), rateLimit: vi.fn() }
  runner.close()
  runner = createAgentRunner({ db: database.db, backend, emit: (event) => events.push(event), account })
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  backend.onAccountInfo = () => Promise.resolve({ apiProvider: 'openrouter' })
  backend.onUsage = () => Promise.resolve({ rate_limits_available: false })
  runner.send(task.id, 'Echo')
  backend.session.emit(sdk.init())
  backend.session.emit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 100 },
  })
  backend.session.emit(sdk.result('Echo', { modelUsage: { [SAMPLE_CHOICE.id]: { contextWindow: 200_000 } } }))
  await settle()
  expect(account.accountRead).not.toHaveBeenCalled()
  expect(account.usageRead).not.toHaveBeenCalled()
  expect(account.rateLimit).not.toHaveBeenCalled()
  expect(getTask(database.db, task.id)?.contextWindowTokens).toBe(SAMPLE_MODEL.contextLength)
})
