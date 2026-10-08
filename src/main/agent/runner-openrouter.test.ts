import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import {
  AgentErrorKind,
  PauseReason,
  TaskActivity,
  WatcherKind,
  WatcherState,
  type Task,
  type TaskPause,
} from '../../shared/domain'
import { addWatcher, listWatchers } from '../db/repositories/watchers'
import { getTask, updateTask } from '../db/repositories/tasks'
import { listMessages } from '../db/repositories/messages'
import { listToolEvents } from '../db/repositories/tool-events'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setOpenRouterChoice, setOpenRouterConnection } from '../db/repositories/openrouter'
import { updateSettings } from '../db/repositories/settings'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { DISPATCH_AGENT_TOOL } from '../../shared/managed-agents'
import { FakeAgentBackend, FakeAgentSession, settle } from './fake-backend'
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
  expect(changed).toMatchObject({ id: task.id, model: SAMPLE_CHOICE.id, pause: null, activity: TaskActivity.Working })
  expect(old.closed).toBe(true)
  expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
  expect(listMessages(database.db, task.id)).toEqual(history)
  expect(listQueuedMessages(database.db, task.id)).toHaveLength(1)
  expect(listToolEvents(database.db, task.id).slice(0, calls.length)).toEqual(calls)
  expect(listToolEvents(database.db, task.id)).toContainEqual(
    expect.objectContaining({
      text: 'Switched model to Sample Flash · Sample Host (OpenRouter)',
    }),
  )
  runner.resumePaused(task.id)
  expect(backend.session.sent.at(-1)?.settings.model).toBe(SAMPLE_CHOICE.id)
  expect(getTask(database.db, task.id)?.pause).toBeNull()
  backend.session.emit(sdk.init())
  backend.session.emit(sdk.result('The tests match.'))
  await settle()
  expect(
    listToolEvents(database.db, task.id).filter((event) => 'text' in event && event.text.startsWith('Switched model')),
  ).toHaveLength(1)
})

it('sends the first prompt of a quiet limit-paused switch unchanged', async () => {
  await previousTurn()
  updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
  runner.queue(task.id, 'Also check its tests.')
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  expect(backend.session.sent).toHaveLength(1)
  expect(backend.session.sent[0]?.text).toBe('Read the sample file and remember its contents.')
})

it('accepts a new message after a paused picker switch without waiting for the Claude reset', async () => {
  await previousTurn()
  updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  expect(backend.session.sent).toHaveLength(1)
  backend.session.emit(sdk.result('Resumed on OpenRouter.'))
  await settle()
  expect(() => runner.send(task.id, 'Continue now.')).not.toThrow()
  expect(backend.session.sent.at(-1)?.text).toBe('Continue now.')
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

it('times out a hung model handoff, closes its process and leaves the original task usable', async () => {
  await previousTurn()
  const old = backend.session
  backend.onSessionStart = (session) => {
    Object.assign(session, { ready: () => new Promise<void>(() => undefined) })
  }
  vi.useFakeTimers()
  try {
    const switching = runner.changeModel(task.id, SAMPLE_CHOICE.id)
    const rejected = expect(switching).rejects.toThrow('within 30 seconds')
    const candidate = backend.session
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(candidate.closed).toBe(true)
    expect(old.closed).toBe(false)
    expect(getTask(database.db, task.id)?.model).toBe(task.model)
    expect(() => runner.send(task.id, 'Continue after timeout')).not.toThrow()
    expect(old.sent.at(-1)?.text).toBe('Continue after timeout')
  } finally {
    vi.useRealTimers()
  }
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

it('commits a source switch after its provisional sandbox overlay succeeds', async () => {
  await previousTurn()
  updateSettings(database.db, { sandboxEnabled: true })
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  expect(getTask(database.db, task.id)?.model).toBe(SAMPLE_CHOICE.id)
  expect(backend.session.closed).toBe(false)
})

it('does not overwrite a task selection changed while its destination starts', async () => {
  await previousTurn()
  const original = backend.session
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
  updateTask(database.db, task.id, { model: 'claude-haiku-4-5' })
  ready()
  await expect(switching).rejects.toThrow('task changed')
  expect(original.closed).toBe(false)
  expect(getTask(database.db, task.id)?.model).toBe('claude-haiku-4-5')
})

it('stops on OpenRouter quota errors without pausing for a Claude subscription reset', async () => {
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  runner.send(task.id, 'Echo')
  backend.session.emit(sdk.init(), ...sdk.usageLimitTurnEnd(Math.ceil(Date.now() / 1000) + 3600))
  await settle()
  expect(getTask(database.db, task.id)).toMatchObject({
    activity: TaskActivity.Error,
    pause: null,
    error: { kind: AgentErrorKind.Permanent },
  })
})

it('pauses an OpenRouter task offline after the SDK exhausts connection retries', async () => {
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  runner.send(task.id, 'Echo')
  backend.session.emit(sdk.init())
  backend.session.fail(new TypeError('fetch failed'))
  await settle()
  expect(getTask(database.db, task.id)).toMatchObject({
    activity: TaskActivity.Paused,
    pause: { reason: PauseReason.Offline },
  })
})

it('closes an idle live session with no saved session ID before changing its source', async () => {
  await previousTurn()
  const original = backend.session
  updateTask(database.db, task.id, { sessionId: null })
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  expect(original.closed).toBe(true)
  runner.send(task.id, 'Start the new source')
  expect(backend.session.options.model).toBe(SAMPLE_CHOICE.id)
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
    text: 'Switched model to Sonnet 5',
  })
  session.emit(sdk.result('Done.'))
  await settle()
  Object.assign(session, { configure: () => Promise.reject(new Error('Model refused')) })
  await runner.changeModel(task.id, 'claude-haiku-4-5')
  runner.send(task.id, 'Continue again')
  await settle()
  expect(getTask(database.db, task.id)?.model).toBe('claude-sonnet-5')
  expect(listToolEvents(database.db, task.id)).toContainEqual(
    expect.objectContaining({ text: 'Could not switch model to Haiku 4.5. Continuing with Sonnet 5.' }),
  )
  expect(
    listToolEvents(database.db, task.id).filter((event) => 'text' in event && event.text.startsWith('Switched model')),
  ).toHaveLength(1)
})

it('refreshes Claude usage when OpenRouter was started first, and returns false for OpenRouter alone', async () => {
  const account = { accountRead: vi.fn(), usageRead: vi.fn(), rateLimit: vi.fn() }
  runner.close()
  runner = createAgentRunner({ db: database.db, backend, emit: (event) => events.push(event), account })
  backend.onUsage = () => Promise.resolve({ limits: [] })
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  runner.send(task.id, 'Start cheap task')
  await settle()
  expect(runner.refreshUsage()).toBe(false)
  const claude = sampleTask(database.db, task.workspaceId)
  runner.send(claude.id, 'Start Claude task')
  await settle()
  account.usageRead.mockClear()
  expect(runner.refreshUsage()).toBe(true)
  await settle()
  expect(account.usageRead).toHaveBeenCalledOnce()
})

it('refuses a switch while a scheduled watcher is live, even though backgroundWork is false', async () => {
  await previousTurn()
  const original = backend.session
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Wakeup,
    toolUseId: 'wake-1',
    parentToolUseId: null,
    sdkId: 'job-1',
    label: 'Follow up',
    detail: 'Check tests',
    cron: null,
    schedule: '1h',
    recurring: false,
    state: WatcherState.Scheduled,
    nextDueAt: Date.now() + 3600_000,
    expiresAt: null,
  })
  expect(getTask(database.db, task.id)?.backgroundWork).toBe(false)
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
  expect(listWatchers(database.db, task.id)[0]?.state).toBe(WatcherState.Scheduled)
  expect(original.closed).toBe(false)
})

it('keeps the original session if it starts an automatic turn during destination preparation', async () => {
  await previousTurn()
  const original = backend.session
  let ready: () => void = () => undefined
  backend.onSessionStart = (session) =>
    Object.assign(session, {
      ready: () =>
        new Promise<void>((resolve) => {
          ready = resolve
        }),
    })
  const switching = runner.changeModel(task.id, SAMPLE_CHOICE.id)
  original.emit(sdk.text('An automatic follow-up started.'))
  await settle()
  ready()
  await expect(switching).rejects.toThrow('started work')
  expect(original.closed).toBe(false)
  expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)
})

it('keeps scheduled work added during destination preparation on the original session', async () => {
  await previousTurn()
  const original = backend.session
  let ready: () => void = () => undefined
  backend.onSessionStart = (session) =>
    Object.assign(session, {
      ready: () =>
        new Promise<void>((resolve) => {
          ready = resolve
        }),
    })
  const switching = runner.changeModel(task.id, SAMPLE_CHOICE.id)
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Wakeup,
    toolUseId: 'wake-late',
    parentToolUseId: null,
    sdkId: 'job-late',
    label: 'Follow up',
    detail: 'Check tests',
    cron: null,
    schedule: '1h',
    recurring: false,
    state: WatcherState.Scheduled,
    nextDueAt: Date.now() + 3600_000,
    expiresAt: null,
  })
  await settle()
  ready()
  await expect(switching).rejects.toThrow('started work')
  expect(original.closed).toBe(false)
  expect(listWatchers(database.db, task.id)[0]?.state).toBe(WatcherState.Scheduled)
})

it('defers a due pause until the handoff settles and resumes only once on the destination', async () => {
  await previousTurn()
  updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
  let ready: () => void = () => undefined
  backend.onSessionStart = (session) =>
    Object.assign(session, {
      ready: () =>
        new Promise<void>((resolve) => {
          ready = resolve
        }),
    })
  const switching = runner.changeModel(task.id, SAMPLE_CHOICE.id)
  runner.resumePaused(task.id)
  expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Paused)
  ready()
  await switching
  expect(backend.session.sent).toHaveLength(1)
  expect(getTask(database.db, task.id)?.pause).toBeNull()
})

it('rejects unsafe, unavailable and mixed-source switches; first-turn selection starts no process', async () => {
  await expect(runner.changeModel('missing', SAMPLE_CHOICE.id)).rejects.toMatchObject({
    code: BridgeErrorCode.NotFound,
  })
  expect((await runner.changeModel(task.id, task.model)).model).toBe(task.model)
  expect((await runner.changeModel(task.id, SAMPLE_CHOICE.id)).model).toBe(SAMPLE_CHOICE.id)
  expect(backend.sessions).toHaveLength(0)
  await runner.changeModel(task.id, 'claude-sonnet-5')
  runner.send(task.id, 'Start')
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
  expect(() => runner.retry(task.id, SAMPLE_CHOICE.id)).toThrow('Select the new model')
  setOpenRouterChoice(database.db, { ...SAMPLE_CHOICE, enabled: false })
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toThrow('Enable this')
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

it('keeps the prepared parent limit when the catalog changes and ignores guessed SDK context windows', async () => {
  const child = {
    ...SAMPLE_CHOICE,
    id: 'openrouter:sample/small@sample-host',
    model: { ...SAMPLE_MODEL, id: 'sample/small', contextLength: 64_000 },
  }
  setOpenRouterChoice(database.db, child)
  expect((await runner.changeModel(task.id, SAMPLE_CHOICE.id)).contextWindowTokens).toBe(128_000)
  backend.onSessionStart = (session) => {
    Object.assign(session, { contextWindowTokens: 64_000 })
  }
  runner.send(task.id, 'Echo')
  setOpenRouterChoice(database.db, { ...child, enabled: false })
  backend.session.emit(sdk.init())
  // A usage that fits the prepared 64k limit, so the turn's result usage doesn't refit the window.
  backend.session.emit(
    sdk.result('Echo', {
      modelUsage: { [SAMPLE_CHOICE.id]: { contextWindow: 1_000_000 } },
      usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 },
    }),
  )
  await settle()
  expect(getTask(database.db, task.id)?.contextWindowTokens).toBe(64_000)
})

it('ends background work when a usage-paused task switches and retries the held turn immediately', async () => {
  await previousTurn()
  const original = backend.session
  await original.callTool('managed-call', DISPATCH_AGENT_TOOL, {
    model: SAMPLE_CHOICE.id,
    prompt: 'Check the file.',
    description: 'Read sample implementation',
    run_in_background: true,
  })
  const child = backend.session
  original.emit(...sdk.backgroundLaunch('bg-call', 'bg-sdk', 'Watch progress'))
  await settle()
  original.emit(sdk.result('Watching.'))
  await settle()
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Wakeup,
    toolUseId: 'pause-wake',
    parentToolUseId: null,
    sdkId: 'pause-job',
    label: 'Follow up',
    detail: 'Check tests',
    cron: null,
    schedule: '1h',
    recurring: false,
    state: WatcherState.Scheduled,
    nextDueAt: Date.now() + 3600_000,
    expiresAt: null,
  })
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Monitor,
    toolUseId: 'monitor',
    parentToolUseId: null,
    sdkId: 'monitor-sdk',
    label: 'Watch tests',
    detail: 'tail -f test.log',
    cron: null,
    schedule: null,
    recurring: true,
    state: WatcherState.Running,
    nextDueAt: null,
    expiresAt: null,
  })
  updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  expect(original.closed).toBe(true)
  expect(child.closed).toBe(true)
  const firstMessage = backend.session.sent[0]?.text ?? ''
  expect(firstMessage).toContain('wakeup: Follow up — Check tests')
  expect(firstMessage).toContain('monitor: Watch tests — tail -f test.log')
  expect(firstMessage).toContain('Child: Watch progress')
  expect(firstMessage).toContain('Child: Read sample implementation')
  expect(firstMessage).toContain('will not report back')
  expect(firstMessage).toContain('Read the sample file and remember its contents.')
  expect(backend.session.submitPrompt(firstMessage)).toBe('allow')
  expect(backend.session.sent).toHaveLength(1)
  expect(getTask(database.db, task.id)).toMatchObject({ model: SAMPLE_CHOICE.id, pause: null, backgroundWork: false })
  expect(listWatchers(database.db, task.id).every(({ state }) => state !== WatcherState.Scheduled)).toBe(true)
  expect(listToolEvents(database.db, task.id)).toContainEqual(
    expect.objectContaining({ output: 'Background work ended when the paused task switched models.' }),
  )
  backend.session.emit(sdk.result('I will restart the required work.'))
  await settle()
  runner.send(task.id, 'Continue.')
  expect(backend.session.sent.at(-1)?.text).toBe('Continue.')
})

/**
 * Leaves a limit-paused task with a dispatched child, a native background child, a scheduled wakeup and a running
 * monitor, as the "ends background work" test sets them up, and snapshots the stored chat and tool calls. With
 * `onOpenRouter`, the task runs a turn on OpenRouter first, so the switch under test can go back to a Claude model.
 */
async function limitPausedWithWork(onOpenRouter = false): Promise<{
  original: FakeAgentSession
  child: FakeAgentSession
  history: ReturnType<typeof listMessages>
  calls: ReturnType<typeof listToolEvents>
}> {
  await previousTurn()
  if (onOpenRouter) {
    await runner.changeModel(task.id, SAMPLE_CHOICE.id)
    runner.send(task.id, 'Note what the tests cover.')
    backend.session.emit(sdk.init())
    backend.session.emit(sdk.result('Noted.'))
    await settle()
  }
  const original = backend.session
  // Dispatch starts a child on the other source: a Claude model when the parent runs on OpenRouter, and vice versa.
  await original.callTool('managed-call', DISPATCH_AGENT_TOOL, {
    model: onOpenRouter ? 'claude-sonnet-5' : SAMPLE_CHOICE.id,
    prompt: 'Check the file.',
    description: 'Read sample implementation',
    run_in_background: true,
  })
  const child = backend.session
  expect(child).not.toBe(original)
  original.emit(...sdk.backgroundLaunch('bg-call', 'bg-sdk', 'Watch progress'))
  await settle()
  original.emit(sdk.result('Watching.'))
  await settle()
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Wakeup,
    toolUseId: 'pause-wake',
    parentToolUseId: null,
    sdkId: 'pause-job',
    label: 'Follow up',
    detail: 'Check tests',
    cron: null,
    schedule: '1h',
    recurring: false,
    state: WatcherState.Scheduled,
    nextDueAt: Date.now() + 3600_000,
    expiresAt: null,
  })
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Monitor,
    toolUseId: 'monitor',
    parentToolUseId: null,
    sdkId: 'monitor-sdk',
    label: 'Watch tests',
    detail: 'tail -f test.log',
    cron: null,
    schedule: null,
    recurring: true,
    state: WatcherState.Running,
    nextDueAt: null,
    expiresAt: null,
  })
  updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
  return { original, child, history: listMessages(database.db, task.id), calls: listToolEvents(database.db, task.id) }
}

it('keeps the stored chat unchanged when the switch note is prepended', async () => {
  const { original, child, history, calls } = await limitPausedWithWork()
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  expect(original.closed).toBe(true)
  expect(child.closed).toBe(true)
  expect(backend.session.sent[0]?.text).toContain('will not report back')
  expect(listMessages(database.db, task.id)).toEqual(history)
  // The children's own tool-call rows are ended by the switch; every earlier row keeps its place.
  expect(listToolEvents(database.db, task.id).slice(0, calls.length - 2)).toEqual(calls.slice(0, calls.length - 2))
})

it('names cron jobs in the switch note and omits the dash when a detail repeats its label', async () => {
  await limitPausedWithWork()
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Cron,
    toolUseId: 'cron-call',
    parentToolUseId: null,
    sdkId: 'cron-job',
    label: 'Nightly sweep',
    detail: 'Report status',
    cron: '0 9 * * *',
    schedule: null,
    recurring: true,
    state: WatcherState.Scheduled,
    nextDueAt: Date.now() + 3600_000,
    expiresAt: null,
  })
  addWatcher(database.db, {
    taskId: task.id,
    kind: WatcherKind.Command,
    toolUseId: 'command',
    parentToolUseId: null,
    sdkId: 'command-sdk',
    label: 'Watch logs',
    detail: 'Watch logs',
    cron: null,
    schedule: null,
    recurring: false,
    state: WatcherState.Running,
    nextDueAt: null,
    expiresAt: null,
  })
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  const firstMessage = backend.session.sent[0]?.text ?? ''
  expect(firstMessage).toContain('cron: Nightly sweep — Report status')
  expect(firstMessage).toContain('command: Watch logs')
  expect(firstMessage).not.toContain('Watch logs —')
})

it('gives the switch note to a limit-paused task switched back to a Claude model', async () => {
  const { original, child } = await limitPausedWithWork(true)
  await runner.changeModel(task.id, 'claude-sonnet-5')
  expect(getTask(database.db, task.id)).toMatchObject({ model: 'claude-sonnet-5', pause })
  expect(original.closed).toBe(true)
  expect(child.closed).toBe(true)
  runner.resumePaused(task.id)
  const firstMessage = backend.session.sent[0]?.text ?? ''
  expect(firstMessage).toContain('Glade stopped the following background work')
  expect(firstMessage).toContain('wakeup: Follow up — Check tests')
  expect(firstMessage).toContain('monitor: Watch tests — tail -f test.log')
  expect(firstMessage).toContain('Child: Watch progress')
  expect(firstMessage).toContain('Child: Read sample implementation')
  expect(firstMessage).toContain('Note what the tests cover.')
})

it('rejects a smaller context window before preparing or committing a handoff', async () => {
  await previousTurn()
  const original = backend.session
  updateTask(database.db, task.id, { contextUsedTokens: 200_000 })
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toThrow(
    'Choose a model with a larger context window',
  )
  expect(backend.sessions).toHaveLength(1)
  expect(original.closed).toBe(false)
  expect(getTask(database.db, task.id)?.model).toBe(task.model)
})

it('keeps an adopted destination live if a post-commit history notification throws', async () => {
  runner.close()
  runner = createAgentRunner({
    db: database.db,
    backend,
    emit: (event) => {
      if (
        event.type === EventType.ToolEventAppended &&
        'text' in event.toolEvent &&
        event.toolEvent.text.startsWith('Switched model')
      )
        throw new Error('Window disconnected')
    },
  })
  await previousTurn()
  await expect(runner.changeModel(task.id, SAMPLE_CHOICE.id)).rejects.toThrow('Window disconnected')
  expect(getTask(database.db, task.id)?.model).toBe(SAMPLE_CHOICE.id)
  expect(backend.session.closed).toBe(false)
  runner.send(task.id, 'Continue after notification failure')
  expect(backend.session.sent.at(-1)?.text).toBe('Continue after notification failure')
})

describe('the context usage on OpenRouter (#568)', () => {
  /**
   * An assistant frame as an OpenRouter turn streams it: the gateway's `message_start` usage, which is zero, with its
   * cache counts null. The real counts arrive only in the stream's final `message_delta`, which the CLI keeps for its
   * turn accounting and the turn's `result`, so the frames it sends never carry them.
   */
  function zeroUsageFrame(message: unknown): unknown {
    const assistantMessage = message as { message: Record<string, unknown> }
    return {
      ...assistantMessage,
      message: {
        ...assistantMessage.message,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    }
  }

  /** A turn's `result` usage as the gateway reports it at the stream's end: the last request's prompt. */
  function openRouterUsage(inputTokens: number): Record<string, unknown> {
    return {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 553,
    }
  }

  /** A first turn on Claude (which reports its usage per message), then the switch to OpenRouter. */
  async function switchedToOpenRouter(): Promise<void> {
    await previousTurn()
    await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  }

  it('counts the context from the turn result when the streamed messages report nothing', async () => {
    await switchedToOpenRouter()
    runner.send(task.id, 'Check the sample file again.')
    backend.session.emit(sdk.init())
    backend.session.emit(zeroUsageFrame(sdk.toolUse('read-1', 'Read', { file_path: '/code/sample.ts' })))
    backend.session.emit(sdk.toolResult('read-1', 'export const answer = 42'))
    backend.session.emit(zeroUsageFrame(sdk.text('The answer is 42.', null, 'msg_02')))
    backend.session.emit(sdk.result('The answer is 42.', { usage: openRouterUsage(41_000) }))
    await settle()
    expect(getTask(database.db, task.id)?.contextUsedTokens).toBe(41_000)
  })

  it('keeps the last real figure while a turn reports zero, then takes the result usage', async () => {
    await switchedToOpenRouter()
    runner.send(task.id, 'Check the sample file again.')
    backend.session.emit(sdk.init())
    backend.session.emit(zeroUsageFrame(sdk.text('Looking.', null, 'msg_01')))
    await settle()
    expect(getTask(database.db, task.id)?.contextUsedTokens).toBe(sdk.CONTEXT_USED)
    backend.session.emit(sdk.result('Done.', { usage: openRouterUsage(41_000) }))
    await settle()
    expect(getTask(database.db, task.id)?.contextUsedTokens).toBe(41_000)
  })

  it('keeps the last real figure when the turn result reports no usage either', async () => {
    await switchedToOpenRouter()
    runner.send(task.id, 'Check the sample file again.')
    backend.session.emit(sdk.init())
    backend.session.emit(zeroUsageFrame(sdk.text('Done.', null, 'msg_01')))
    backend.session.emit(sdk.result('Done.', { usage: openRouterUsage(0) }))
    await settle()
    expect(getTask(database.db, task.id)?.contextUsedTokens).toBe(sdk.CONTEXT_USED)
  })

  it('prefers the messages own figures when they report the context', async () => {
    await switchedToOpenRouter()
    runner.send(task.id, 'Check the sample file again.')
    backend.session.emit(sdk.init())
    backend.session.emit(sdk.withContextUsed(sdk.text('Done.', null, 'msg_01'), 30_000))
    backend.session.emit(sdk.result('Done.', { usage: openRouterUsage(41_000) }))
    await settle()
    expect(getTask(database.db, task.id)?.contextUsedTokens).toBe(30_000)
  })

  it('keeps the compaction boundary figure when a compacting turn reports nothing', async () => {
    await switchedToOpenRouter()
    runner.send(task.id, 'Check the sample file again.')
    backend.session.emit(sdk.init(), ...sdk.compaction(90_000, 12_000, 'auto'))
    backend.session.emit(zeroUsageFrame(sdk.text('Continued.', null, 'msg_01')))
    backend.session.emit(sdk.result('Continued.', { usage: openRouterUsage(90_000) }))
    await settle()
    expect(getTask(database.db, task.id)?.contextUsedTokens).toBe(12_000)
  })
})
