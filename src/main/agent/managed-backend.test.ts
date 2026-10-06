import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CompactionTrigger, Effort, PermissionMode } from '../../shared/domain'
import { AGENTS_SERVER, DISPATCH_AGENT_TOOL } from '../../shared/managed-agents'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { setOpenRouterConnection, setOpenRouterChoice } from '../db/repositories/openrouter'
import { setSdkModels } from '../db/repositories/sdk-models'
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

it('starts a dispatched child at its parent effort when the model offers it', async () => {
  start({ effort: Effort.High })
  const dispatched = parent.callTool('dispatch', DISPATCH_AGENT_TOOL, INPUT)
  const agent = await child()
  expect(agent.options.effort).toBe(Effort.High)
  agent.emit(sdk.result('Checked'))
  await dispatched
})

it('starts a dispatched child at the model default when it does not offer the parent effort', async () => {
  setSdkModels(database.db, [
    {
      id: 'claude-opus-5-5',
      resolvedModel: 'claude-opus-5-5',
      name: 'Opus 5.5',
      description: '',
      efforts: [Effort.Low, Effort.Medium, Effort.High],
    },
  ])
  start({ effort: Effort.Max })
  const dispatched = parent.callTool('dispatch', DISPATCH_AGENT_TOOL, { ...INPUT, model: 'claude-opus-5-5' })
  const agent = await child()
  expect(agent.options.effort).toBe(Effort.High)
  agent.emit(sdk.result('Checked'))
  await dispatched
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

it('dispatches an isolated foreground child into its own worktree and names it in the result', async () => {
  start()
  const emitted = vi.spyOn(parent, 'emit')
  const dispatched = parent.callTool('iso', DISPATCH_AGENT_TOOL, { ...INPUT, isolation: 'worktree' })
  const agent = await child()
  const row = record()
  expect(agent.options.worktree).toBe(row.text('id'))
  expect(row.text('worktree')).toBe(row.text('id'))
  agent.emit(sdk.result('Checked'))
  await dispatched
  expect(JSON.stringify(emitted.mock.calls)).toContain(`.claude/worktrees/${row.text('id')}`)
  expect(JSON.stringify(emitted.mock.calls)).toContain(`worktree-${row.text('id')}`)
})

it('dispatches a plain child without a worktree and says nothing of one', async () => {
  start()
  const emitted = vi.spyOn(parent, 'emit')
  const dispatched = parent.callTool('plain', DISPATCH_AGENT_TOOL, INPUT)
  const agent = await child()
  expect(agent.options.worktree).toBeUndefined()
  expect(record().nullableText('worktree')).toBeNull()
  agent.emit(sdk.result('Checked'))
  await dispatched
  expect(JSON.stringify(emitted.mock.calls)).not.toContain('.claude/worktrees')
})

it('names an isolated background child worktree at start and in the delivered completion', async () => {
  start()
  const emitted = vi.spyOn(parent, 'emit')
  await parent.callTool('bg', DISPATCH_AGENT_TOOL, { ...INPUT, run_in_background: true, isolation: 'worktree' })
  const agent = await child()
  const id = record().text('id')
  expect(JSON.stringify(emitted.mock.calls)).toContain(`.claude/worktrees/${id}`)
  agent.emit(sdk.result('Checked'))
  await settle()
  expect(parent.sent.at(-1)?.text).toContain(`.claude/worktrees/${id}`)
})

it('resumes a worktree child into the worktree its first run had', async () => {
  start()
  const first = parent.callTool('first', DISPATCH_AGENT_TOOL, { ...INPUT, isolation: 'worktree' })
  const firstAgent = await child()
  firstAgent.emit(sdk.result('First done'))
  await first
  const firstId = record().text('id')
  database.db.prepare("UPDATE managed_agents SET session_id = 'saved-session'").run()
  const second = parent.callTool('second', DISPATCH_AGENT_TOOL, { ...INPUT, resume: firstId })
  await vi.waitFor(() => {
    expect(backend.sessions).toHaveLength(3)
  })
  await settle()
  const secondAgent = backend.session
  expect(secondAgent.options.worktree).toBe(firstId)
  expect(secondAgent.options.resumeSessionId).toBe('saved-session')
  expect(
    new Row(
      'managed_agents',
      database.db.prepare('SELECT * FROM managed_agents WHERE id = ?').get(firstId),
    ).nullableText('worktree'),
  ).toBe(firstId)
  secondAgent.emit(sdk.result('Second done'))
  await second
})

it('ignores isolation when resuming a child that had no worktree', async () => {
  start()
  const first = parent.callTool('first', DISPATCH_AGENT_TOOL, INPUT)
  const firstAgent = await child()
  firstAgent.emit(sdk.result('First done'))
  await first
  const firstId = record().text('id')
  database.db.prepare("UPDATE managed_agents SET session_id = 'saved-session'").run()
  const second = parent.callTool('second', DISPATCH_AGENT_TOOL, { ...INPUT, resume: firstId, isolation: 'worktree' })
  await vi.waitFor(() => {
    expect(backend.sessions).toHaveLength(3)
  })
  await settle()
  const secondAgent = backend.session
  expect(secondAgent.options.worktree).toBeUndefined()
  const secondRow = database.db.prepare('SELECT * FROM managed_agents WHERE id <> ?').get(firstId)
  expect(new Row('managed_agents', secondRow).nullableText('worktree')).toBeNull()
  secondAgent.emit(sdk.result('Second done'))
  await second
})

it('refuses a worktree dispatch from a sandboxed session', async () => {
  start({ flagSettings: { sandbox: { enabled: true } } })
  const emitted = vi.spyOn(parent, 'emit')
  await parent.callTool('sandboxed', DISPATCH_AGENT_TOOL, { ...INPUT, isolation: 'worktree' })
  expect(JSON.stringify(emitted.mock.calls)).toContain('A sandboxed session cannot give a child a git worktree')
  expect(backend.sessions).toHaveLength(1)
  expect(database.db.prepare('SELECT * FROM managed_agents').get()).toBeUndefined()
})

it('replays a finished worktree dispatch with its worktree note and no new session', async () => {
  start()
  const first = parent.callTool('iso', DISPATCH_AGENT_TOOL, { ...INPUT, isolation: 'worktree' })
  const agent = await child()
  agent.emit(sdk.result('Checked'))
  await first
  const id = record().text('id')
  const emitted = vi.spyOn(parent, 'emit')
  emitted.mockClear()
  await parent.callTool('iso', DISPATCH_AGENT_TOOL, { ...INPUT, isolation: 'worktree' })
  expect(JSON.stringify(emitted.mock.calls)).toContain(`.claude/worktrees/${id}`)
  expect(backend.sessions).toHaveLength(2)
})

it('gives a child dispatched by an isolated child the same worktree', async () => {
  start()
  const childCall = parent.callTool('child', DISPATCH_AGENT_TOOL, { ...INPUT, isolation: 'worktree' })
  const agent = await child()
  const childId = record().text('id')
  void agent.callTool('grandchild', DISPATCH_AGENT_TOOL, { ...INPUT, model: SAMPLE_CHOICE.id })
  await vi.waitFor(() => {
    expect(backend.sessions).toHaveLength(3)
  })
  await settle()
  const grandchild = backend.session
  expect(grandchild.options.worktree).toBe(childId)
  grandchild.emit(sdk.result('Grandchild done'))
  await settle()
  agent.emit(sdk.result('Child done'))
  await childCall
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
  expect(parent.options.systemPromptAppend).toContain('Pass isolation: "worktree"')
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
