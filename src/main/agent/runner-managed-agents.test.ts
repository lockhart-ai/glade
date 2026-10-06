import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_MODELS_TOOL, DISPATCH_AGENT_TOOL } from '../../shared/managed-agents'
import { ToolCallState, ToolEventKind, type Task } from '../../shared/domain'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setOpenRouterChoice, setOpenRouterConnection } from '../db/repositories/openrouter'
import { getTask, updateTask } from '../db/repositories/tasks'
import { getToolCall, listToolEvents } from '../db/repositories/tool-events'
import { listMessages } from '../db/repositories/messages'
import { Row } from '../db/repositories/rows'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { FakeAgentBackend, type FakeAgentSession, settle } from './fake-backend'
import { createAgentRunner, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

const CLAUDE = 'claude-haiku-4-5'
let database: TestDatabase
let backend: FakeAgentBackend
let runner: AgentRunner
let task: Task
let log: MemoryLog
const account = { accountRead: vi.fn(), usageRead: vi.fn(), rateLimit: vi.fn() }
beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  backend = new FakeAgentBackend()
  log = createMemoryLog()
  runner = createAgentRunner({ db: database.db, backend, emit: () => undefined, account, log: log.logger })
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('ciphertext'),
    models: [SAMPLE_MODEL],
    providers: [SAMPLE_PROVIDER],
  })
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
})
afterEach(async () => {
  runner.close()
  await settle()
  database.close()
  vi.clearAllMocks()
})
function start(model = CLAUDE): FakeAgentSession {
  updateTask(database.db, task.id, { model })
  runner.send(task.id, 'Delegate this work.')
  const parent = backend.session
  parent.emit(sdk.init())
  return parent
}
function input(model = SAMPLE_CHOICE.id, background = false) {
  return { model, prompt: 'Read the sample file.', description: 'Read the file', run_in_background: background }
}
async function launched(count = 2): Promise<FakeAgentSession> {
  await vi.waitFor(() => {
    expect(backend.sessions).toHaveLength(count)
  })
  await settle()
  return backend.session
}
function childId(call: string): string {
  return new Row(
    'managed_agents',
    database.db.prepare('SELECT id FROM managed_agents WHERE tool_use_id = ?').get(call),
  ).text('id')
}

it.each([
  [CLAUDE, SAMPLE_CHOICE.id],
  [SAMPLE_CHOICE.id, CLAUDE],
])('routes %s → %s independently and keeps child activity out of the main chat', async (parentModel, childModel) => {
  const parent = start(parentModel)
  const dispatched = callTool(parent, DISPATCH_AGENT_TOOL, input(childModel), 'dispatch-1')
  const child = await launched()
  expect(child.options.model).toBe(childModel)
  expect(child.options.managedAgentId).toBe(childId('dispatch-1'))
  expect(child.options.systemPromptAppend).toContain('delegated subagent')
  expect(child.sent[0]?.text).toBe('Read the sample file.')
  child.emit(
    sdk.init('saved-child'),
    sdk.text('Reading the file.'),
    sdk.toolUse('read-child', 'Read', { file_path: '/code/sample.ts' }),
  )
  child.emit(sdk.toolResult('read-child', '42'), sdk.result('The answer is 42.'))
  await dispatched
  await settle()
  expect(child.closed).toBe(true)
  expect(parent.closed).toBe(false)
  expect(getTask(database.db, task.id)).toMatchObject({ model: parentModel, sessionId: sdk.SESSION_ID })
  expect(getToolCall(database.db, task.id, 'read-child')).toMatchObject({
    parentToolUseId: 'dispatch-1',
    state: ToolCallState.Done,
    output: '42',
  })
  expect(getToolCall(database.db, task.id, 'dispatch-1')).toMatchObject({
    input: input(childModel),
    state: ToolCallState.Done,
  })
  expect(listMessages(database.db, task.id).some(({ body }) => body.includes('42'))).toBe(false)
  expect(listToolEvents(database.db, task.id)).toContainEqual(
    expect.objectContaining({
      kind: ToolEventKind.Narration,
      parentToolUseId: 'dispatch-1',
      text: 'Reading the file.',
    }),
  )
  expect(
    new Row(
      'managed_agents',
      database.db.prepare('SELECT * FROM managed_agents WHERE tool_use_id = ?').get('dispatch-1'),
    ).text('session_id'),
  ).toBe('saved-child')
})

it('keeps the catalog live and checks curation for each dispatch', async () => {
  const parent = start()
  const second = {
    ...SAMPLE_CHOICE,
    id: 'openrouter:sample/small@sample-host',
    model: { ...SAMPLE_MODEL, id: 'sample/small', contextLength: 64000 },
  }
  setOpenRouterChoice(database.db, second)
  await callTool(parent, AGENT_MODELS_TOOL, {}, 'models')
  await settle()
  expect(getToolCall(database.db, task.id, 'models')?.output).toContain(second.id)
  expect(getToolCall(database.db, task.id, 'models')?.output).toContain('USD per token')
  setOpenRouterChoice(database.db, { ...SAMPLE_CHOICE, enabled: false })
  await callTool(parent, DISPATCH_AGENT_TOOL, input(), 'disabled')
  await callTool(parent, DISPATCH_AGENT_TOOL, input('invented-model'), 'unknown')
  await settle()
  expect(backend.sessions).toHaveLength(1)
  expect(getToolCall(database.db, task.id, 'disabled')?.state).toBe(ToolCallState.Error)
  expect(getToolCall(database.db, task.id, 'disabled')?.output).toContain('Enable this')
  expect(getToolCall(database.db, task.id, 'unknown')?.output).toContain('list_models')
  const dispatched = callTool(parent, DISPATCH_AGENT_TOOL, input(second.id), 'new-route', undefined, {
    namesCall: false,
  })
  const child = await launched()
  child.emit(sdk.result('Done'))
  await dispatched
})

it('keeps concurrent background children running after the parent turn and delivers success or failure', async () => {
  const parent = start()
  await callTool(parent, DISPATCH_AGENT_TOOL, input(SAMPLE_CHOICE.id, true), 'background-1')
  const first = backend.session
  await callTool(parent, DISPATCH_AGENT_TOOL, input(SAMPLE_CHOICE.id, true), 'background-2')
  const second = await launched(3)
  parent.emit(sdk.result('The work is in progress.'))
  await settle()
  expect(getToolCall(database.db, task.id, 'background-1')?.state).toBe(ToolCallState.Running)
  expect(getTask(database.db, task.id)?.backgroundWork).toBe(true)
  first.emit(sdk.text('Working'), sdk.result('First done'))
  second.fail(new Error('Child connection failed'))
  await vi.waitFor(() => {
    expect(parent.sent).toHaveLength(3)
  })
  expect(parent.sent.map(({ text }) => text)).toEqual(
    expect.arrayContaining([expect.stringContaining('First done'), expect.stringContaining('Child connection failed')]),
  )
  expect(getToolCall(database.db, task.id, 'background-1')?.state).toBe(ToolCallState.Done)
  expect(getToolCall(database.db, task.id, 'background-2')?.state).toBe(ToolCallState.Error)
  expect(getTask(database.db, task.id)?.backgroundWork).toBe(false)
})

it('stops a nested mixed-source child through the existing Agents control', async () => {
  const parent = start()
  await callTool(parent, DISPATCH_AGENT_TOOL, input(SAMPLE_CHOICE.id, true), 'child')
  const child = await launched()
  await callTool(child, DISPATCH_AGENT_TOOL, input(CLAUDE, true), 'grandchild')
  const grandchild = await launched(3)
  expect(getToolCall(database.db, task.id, 'grandchild')?.parentToolUseId).toBe('child')
  await runner.stopSubagent(task.id, 'grandchild')
  expect(grandchild.closed).toBe(true)
  expect(child.closed).toBe(false)
  expect(parent.closed).toBe(false)
  expect(getToolCall(database.db, task.id, 'grandchild')?.state).toBe(ToolCallState.Error)
  child.emit(sdk.result('Finished'))
  await settle()
})

it('resumes a saved cross-source child and refuses same-source dispatch after a parent switch', async () => {
  const parent = start()
  const dispatched = callTool(parent, DISPATCH_AGENT_TOOL, input(), 'first')
  const child = await launched()
  child.emit(sdk.init('child-session'), sdk.result('Remember 42'))
  await dispatched
  parent.emit(sdk.result('Child complete'))
  await settle()
  const previous = childId('first')
  await runner.changeModel(task.id, SAMPLE_CHOICE.id)
  await callTool(backend.session, DISPATCH_AGENT_TOOL, { ...input(), resume: previous }, 'same-source')
  await settle()
  expect(getToolCall(database.db, task.id, 'same-source')?.output).toContain('built-in Agent')
  backend.session.emit(sdk.result('Use the native tool for this source.'))
  await settle()
  await runner.changeModel(task.id, CLAUDE)
  const switched = backend.session
  runner.send(task.id, 'Continue the child')
  const resumed = callTool(switched, DISPATCH_AGENT_TOOL, { ...input(), resume: previous }, 'resume')
  const next = await launched(5)
  expect(next.options.resumeSessionId).toBe('child-session')
  expect(next.options.model).toBe(SAMPLE_CHOICE.id)
  next.emit(sdk.result('Still 42'))
  await resumed
  const alternate = {
    ...SAMPLE_CHOICE,
    id: 'openrouter:sample/other@sample-host',
    model: { ...SAMPLE_MODEL, id: 'sample/other' },
  }
  setOpenRouterChoice(database.db, alternate)
  await callTool(switched, DISPATCH_AGENT_TOOL, { ...input(alternate.id), resume: previous }, 'wrong-model')
  await callTool(switched, DISPATCH_AGENT_TOOL, { ...input(), resume: 'another-task-child' }, 'missing-child')
  await settle()
  expect(getToolCall(database.db, task.id, 'wrong-model')?.output).toContain('original model')
  expect(getToolCall(database.db, task.id, 'missing-child')?.output).toContain('in this task')
})

it('updates Claude usage for a Claude child of an OpenRouter parent without pausing or replacing the parent account source', async () => {
  backend.onAccountInfo = () => Promise.resolve({ apiProvider: 'firstParty' })
  backend.onUsage = () => Promise.resolve({ rate_limits_available: true })
  const parent = start(SAMPLE_CHOICE.id)
  const dispatched = callTool(parent, DISPATCH_AGENT_TOOL, input(CLAUDE), 'account-child')
  const child = await launched()
  child.emit(
    sdk.init('account-child-session'),
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 100 } },
    sdk.result('Done'),
  )
  await dispatched
  await settle()
  expect(account.accountRead).toHaveBeenCalledOnce()
  expect(account.usageRead).toHaveBeenCalledTimes(2)
  expect(account.rateLimit).toHaveBeenCalledOnce()
  expect(getTask(database.db, task.id)).toMatchObject({
    model: SAMPLE_CHOICE.id,
    sessionId: sdk.SESSION_ID,
    pause: null,
  })
})

function callTool(
  session: FakeAgentSession,
  name: string,
  input: Record<string, unknown>,
  id: string,
  signal?: AbortSignal,
  caller?: Parameters<FakeAgentSession['callTool']>[4],
): Promise<void> {
  return session.callTool(id, name, input, signal, caller)
}

it('logs a failed child event without killing its parent or losing later child events', async () => {
  const parent = start()
  const dispatched = callTool(parent, DISPATCH_AGENT_TOOL, input(), 'child')
  const child = await launched()
  database.db.exec(
    "CREATE TEMP TRIGGER reject_child_event BEFORE INSERT ON tool_events BEGIN SELECT RAISE(ABORT, 'disk write failed'); END",
  )
  child.emit(sdk.toolUse('failed-write', 'Read', { file_path: '/code/file.ts' }))
  await settle()
  database.db.exec('DROP TRIGGER reject_child_event')
  expect(log.withMessage('failed to handle a child event')).toHaveLength(1)
  child.emit(
    sdk.toolUse('retry-write', 'Read', { file_path: '/code/file.ts' }),
    sdk.toolResult('retry-write', 'OK'),
    sdk.result('Done'),
  )
  await dispatched
  await settle()
  expect(getToolCall(database.db, task.id, 'retry-write')?.state).toBe(ToolCallState.Done)
  expect(parent.closed).toBe(false)
})

it.each([CLAUDE, SAMPLE_CHOICE.id])('keeps same-source children on the native Agent tool for %s', async (model) => {
  const parent = start(model)
  await callTool(parent, DISPATCH_AGENT_TOOL, input(model), 'same-source')
  await settle()
  expect(backend.sessions).toHaveLength(1)
  expect(getToolCall(database.db, task.id, 'same-source')?.output).toContain('built-in Agent tool')
  parent.emit(...sdk.backgroundLaunch('native', 'native-sdk', 'Check with the native agent'))
  await settle()
  await runner.stopSubagent(task.id, 'native')
  expect(parent.stoppedTasks).toEqual(['native-sdk'])
})
