import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CompactionTrigger, Effort, PermissionMode } from '../../shared/domain'
import { AGENTS_SERVER, DISPATCH_AGENT_TOOL } from '../../shared/managed-agents'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { setOpenRouterConnection, setOpenRouterChoice } from '../db/repositories/openrouter'
import { Row } from '../db/repositories/rows'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { PromptVerdict, ToolPermissionBehavior, type AgentSession, type AgentSessionOptions } from './backend'
import { AgentEventKind, TaskOutcome, type AgentEvent } from './events'
import { FakeAgentBackend, type FakeAgentSession, settle } from './fake-backend'
import { managedBackend } from './managed-backend'
import * as sdk from './test-sdk-messages'

const MODEL = 'claude-haiku-4-5'
const INPUT = { model: MODEL, prompt: 'Check the sample file.', description: 'Check the file' }
let database: TestDatabase
let backend: FakeAgentBackend
let session: AgentSession
let parent: FakeAgentSession
let log: MemoryLog
let options: AgentSessionOptions
let events: AgentEvent[]
const account = { accountRead: vi.fn(), usageRead: vi.fn(), rateLimit: vi.fn() }
beforeEach(() => {
  database = openTestDatabase()
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('ciphertext'),
    models: [SAMPLE_MODEL],
    providers: [SAMPLE_PROVIDER],
  })
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
  const workspace = sampleWorkspace(database.db)
  const task = sampleTask(database.db, workspace.id)
  backend = new FakeAgentBackend()
  log = createMemoryLog()
  events = []
  options = {
    taskId: task.id,
    cwd: workspace.rootPath,
    model: SAMPLE_CHOICE.id,
    effort: Effort.Low,
    permissionMode: PermissionMode.AskBeforeEdits,
    resumeSessionId: null,
    systemPromptAppend: '',
    mcpServers: {},
    log: log.logger,
    onSubagentEvent: (event) => events.push(event),
  }
})
afterEach(async () => {
  session.close()
  await settle()
  database.close()
  vi.restoreAllMocks()
})
function start(overrides: Partial<AgentSessionOptions> = {}): void {
  session = managedBackend({ db: database.db, backend, account }).start({ ...options, ...overrides })
  parent = backend.session
}
async function child(): Promise<FakeAgentSession> {
  await vi.waitFor(() => {
    expect(backend.sessions).toHaveLength(2)
  })
  await settle()
  return backend.session
}
function record(): Row {
  return new Row('managed_agents', database.db.prepare('SELECT * FROM managed_agents').get())
}

it('keeps permission ownership and sandbox changes on the child without running parent upkeep hooks', async () => {
  const permission = vi.fn(() => Promise.resolve({ behavior: ToolPermissionBehavior.Allow as const, byUser: true }))
  const access = vi.fn()
  const tool = vi.fn(() => Promise.resolve(null))
  const prompt = vi.fn(() => PromptVerdict.Block)
  const ended = vi.fn()
  const compacted = vi.fn()
  start({
    onToolPermission: permission,
    hooks: {
      onPrompt: prompt,
      onTurnEnded: ended,
      onCompacted: compacted,
      onAccessRequested: access,
      onToolStarting: tool,
    },
  })
  const dispatched = parent.callTool('dispatch', DISPATCH_AGENT_TOOL, INPUT)
  const agent = await child()
  const id = record().text('id')
  await agent.requestPermission({ toolUseId: 'edit', toolName: 'Edit', input: {} }).answer
  agent.options.hooks?.onAccessRequested?.({ toolUseId: 'access', agentId: null, input: {} })
  await agent.startTool({ toolUseId: 'read', toolName: 'Read', input: {} }).decision
  expect(permission).toHaveBeenCalledWith(expect.objectContaining({ agentId: id }))
  expect(access).toHaveBeenCalledWith(expect.objectContaining({ agentId: id }))
  expect(tool).toHaveBeenCalledWith(expect.objectContaining({ agentId: id }))
  expect(agent.submitPrompt('Continue')).toBe(PromptVerdict.Allow)
  agent.endTurn()
  agent.compacted({ trigger: CompactionTrigger.Auto, summary: 'Child context' })
  expect(prompt).not.toHaveBeenCalled()
  expect(ended).not.toHaveBeenCalled()
  expect(compacted).not.toHaveBeenCalled()
  await session.configure({ model: SAMPLE_CHOICE.id, effort: Effort.High, permissionMode: PermissionMode.AllowAll })
  expect(agent.settings).toMatchObject({ model: MODEL, permissionMode: PermissionMode.AllowAll })
  await session.applyFlagSettings({ permissions: null })
  expect(agent.flagSettings).toEqual([{ permissions: null }])
  agent.emit(sdk.result('Checked'))
  await dispatched
})

it('routes native descendant stops to the owning session and ends leftover descendants', async () => {
  start()
  expect(parent.submitPrompt('Work')).toBe(PromptVerdict.Allow)
  parent.endTurn()
  parent.compacted({ trigger: CompactionTrigger.Manual, summary: 'Parent context' })
  await parent.callTool('dispatch', DISPATCH_AGENT_TOOL, { ...INPUT, run_in_background: true })
  const agent = await child()
  agent.emit(...sdk.backgroundLaunch('native', 'native-sdk', 'Check tests'))
  await settle()
  await session.stopTask('native-sdk')
  expect(agent.stoppedTasks).toEqual(['native-sdk'])
  expect(parent.stoppedTasks).toEqual([])
  agent.emit(...sdk.backgroundEnded('native', 'native-sdk', 'stopped', 'Stopped'))
  agent.emit(...sdk.backgroundLaunch('leftover', 'leftover-sdk', 'Read docs'))
  agent.emit(sdk.result('Done'))
  await settle()
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: AgentEventKind.TaskFinished,
      sdkTaskId: 'leftover-sdk',
      outcome: TaskOutcome.Stopped,
      summary: 'The delegated agent ended.',
    }),
  )
  expect(
    events.filter((event) => event.kind === AgentEventKind.TaskFinished && event.sdkTaskId === 'native-sdk'),
  ).toHaveLength(1)
  expect(agent.closed).toBe(true)
})

it('does not start a second child when a saved dispatch is replayed', async () => {
  start()
  const first = parent.callTool('same-dispatch', DISPATCH_AGENT_TOOL, INPUT)
  const agent = await child()
  agent.emit(sdk.result('Saved result'))
  await first
  await parent.callTool('same-dispatch', DISPATCH_AGENT_TOOL, INPUT)
  expect(backend.sessions).toHaveLength(2)
  expect(record().text('result')).toBe('Saved result')
})

it('persists startup failures and keeps the parent usable', async () => {
  start()
  backend.onSessionStart = (agent) => {
    if (agent.options.managedAgentId !== undefined) throw new Error('Cannot start the child process')
  }
  await parent.callTool('failed', DISPATCH_AGENT_TOOL, INPUT)
  expect(record().text('state')).toBe(TaskOutcome.Failed)
  expect(record().text('result')).toContain('Cannot start the child process')
  expect(parent.closed).toBe(false)
})

it('cancels a foreground child when its dispatch is aborted', async () => {
  start()
  const abort = new AbortController()
  const dispatched = parent.callTool('cancelled', DISPATCH_AGENT_TOOL, INPUT, abort.signal)
  const rejected = expect(dispatched).rejects.toThrow()
  const agent = await child()
  abort.abort()
  await rejected
  await vi.waitFor(() => {
    expect(agent.closed).toBe(true)
  })
  expect(record().text('state')).toBe(TaskOutcome.Stopped)
  expect(parent.closed).toBe(false)
})

it('retains the child result when usage reads and delivery to its parent fail', async () => {
  backend.onAccountInfo = () => Promise.reject(new Error('Account read unavailable'))
  backend.onUsage = () => Promise.reject(new Error('Usage read unavailable'))
  start()
  await parent.callTool('background', DISPATCH_AGENT_TOOL, { ...INPUT, run_in_background: true })
  const agent = await child()
  vi.spyOn(parent, 'send').mockImplementation(() => {
    throw new Error('Parent input closed')
  })
  agent.emit(sdk.result('Persisted result'))
  await settle()
  expect(record().text('result')).toBe('Persisted result')
  expect(record().text('state')).toBe(TaskOutcome.Completed)
  expect(log.withMessage('could not read child account')).toHaveLength(1)
  expect(log.withMessage('could not read child account usage')).toHaveLength(2)
  expect(log.withMessage('could not deliver child completion')).toHaveLength(1)
})

it('passes Claude-only sessions through with exactly their existing prompt, tools and hooks', () => {
  database.db.exec('DELETE FROM openrouter_connection')
  options = { ...options, model: MODEL, systemPromptAppend: 'Original Glade prompt.' }
  session = managedBackend({ db: database.db, backend }).start(options)
  expect(backend.session.options).toBe(options)
  expect(session).toBe(backend.session)
  expect(backend.session.options.mcpServers).not.toHaveProperty(AGENTS_SERVER)
})

it('adds only cross-source delegation instructions when an OpenRouter key is connected', () => {
  start({ model: MODEL, systemPromptAppend: 'Original Glade prompt.' })
  expect(parent.options.systemPromptAppend.startsWith('Original Glade prompt.\n')).toBe(true)
  expect(parent.options.systemPromptAppend).toContain('Use the built-in Agent tool for subagents on your own source')
  expect(parent.options.systemPromptAppend).toContain('Only to start a child on the other source')
  expect(parent.options.mcpServers).toHaveProperty(AGENTS_SERVER)
})

it('interrupts foreground cross-source work while leaving background children running', async () => {
  start()
  await parent.callTool('background', DISPATCH_AGENT_TOOL, { ...INPUT, run_in_background: true })
  const background = await child()
  const foregroundCall = parent.callTool('foreground', DISPATCH_AGENT_TOOL, INPUT)
  await vi.waitFor(() => {
    expect(backend.sessions).toHaveLength(3)
  })
  const foreground = backend.session
  await session.interrupt()
  await foregroundCall
  expect(foreground.closed).toBe(true)
  expect(background.closed).toBe(false)
  expect(parent.interrupts).toBe(1)
  expect(parent.closed).toBe(false)
})
