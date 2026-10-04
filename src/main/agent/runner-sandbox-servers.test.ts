// What runs outside the sandbox is a grant of its own (#515): an MCP server Glade doesn't build (the user's, a
// repository's, a claude.ai connector), asked for once per server, and `SendMessage` to anything but the task's own
// subagents, and `RemoteTrigger`. Each call is put to the session's `PreToolUse` hook, as it arrives whatever rule in
// the user's settings would let it through. A fake agent session behind the real bridge, in a temporary home folder.
import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import {
  PermissionDecisionKind,
  PermissionMarkKind,
  PermissionMode,
  PermissionRequestState,
  TaskActivity,
  UiStateKey,
  type PermissionDecision,
  type PermissionRequest,
  type Task,
  type ToolInput,
  type Workspace,
} from '../../shared/domain'
import {
  OtherAgents,
  SandboxAskKind,
  SandboxGrantKind,
  SandboxGrantScope,
  SETTINGS_GRANT_REFUSALS,
  type Grant,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listPermissionMarks } from '../db/repositories/permission-marks'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { listReportedServers } from '../db/repositories/reported-mcp-servers'
import { addSandboxGrant, listSandboxGrants } from '../db/repositories/sandbox-grants'
import { updateSettings } from '../db/repositories/settings'
import { addTaskPermissionRule } from '../db/repositories/task-permission-rules'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { ToolPermissionBehavior, type McpServerOrigin, type ToolStartDecision } from './backend'
import { FakeAgentBackend, settle, type FakeAgentSession } from './fake-backend'
import { alreadyDeniedMessage, PERMISSION_WITHDRAWN_NOTE, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

/** A home folder of the tests' own, made before anything reads where home is. */
const FAKE_HOME = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glade-home-')))
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => FAKE_HOME }
  return { ...mocked, default: mocked }
})

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
})

const HOME = homedir()
const ROOT = `${HOME}/src/acme-api`
const OTHER_ROOT = `${HOME}/src/acme-web`

/** A claude.ai connector, a server from the repository's `.mcp.json`, and one from the user's own config. */
const DOCS: McpServerOrigin = { name: 'claude.ai Acme Docs', source: 'claudeai' }
const TRACKER: McpServerOrigin = { name: 'acme-tracker', source: 'project' }
const GMAIL: McpServerOrigin = { name: 'gmail', source: 'user' }
/** Glade's own, as the SDK names an in-process server. */
const GLADE: McpServerOrigin = { name: 'glade', source: 'sdk' }
const CONTROL: McpServerOrigin = { name: 'glade-control', source: 'sdk' }

const SEARCH = 'mcp__claude_ai_Acme_Docs__search'
const READ = 'mcp__claude_ai_Acme_Docs__read'
const ISSUE = 'mcp__acme-tracker__create_issue'

const DOCS_ASK = { kind: SandboxAskKind.McpServer, server: 'claude_ai_Acme_Docs', name: 'claude.ai Acme Docs' }
const TRACKER_ASK = { kind: SandboxAskKind.McpServer, server: 'acme-tracker', name: 'acme-tracker' }
const SESSIONS_ASK = { kind: SandboxAskKind.Agents, agents: OtherAgents.Sessions }
const CLOUD_ASK = { kind: SandboxAskKind.Agents, agents: OtherAgents.Cloud }

const DOCS_GRANT: Grant = {
  kind: SandboxGrantKind.McpServer,
  server: 'claude_ai_Acme_Docs',
  name: 'claude.ai Acme Docs',
}
const TRACKER_GRANT: Grant = { kind: SandboxGrantKind.McpServer, server: 'acme-tracker', name: 'acme-tracker' }
const SESSIONS_GRANT: Grant = { kind: SandboxGrantKind.Agents, agents: OtherAgents.Sessions }
const CLOUD_GRANT: Grant = { kind: SandboxGrantKind.Agents, agents: OtherAgents.Cloud }

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let log: MemoryLog
let events: GladeEvent[]

function launch(): void {
  backend = new FakeAgentBackend()
  log = createMemoryLog()
  events = []
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: backend,
    log: log.logger,
  }))
  glade = createBridge(ipc.renderer)
  glade.subscribe((event) => events.push(event))
}

/** Quits the app and starts it again on the same database. */
function relaunch(): void {
  runner.close()
  launch()
  runner.resumeInterrupted()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  mkdirSync(ROOT, { recursive: true })
  mkdirSync(OTHER_ROOT, { recursive: true })
  database = openTestDatabase()
  updateSettings(database.db, { sandboxEnabled: true })
  workspace = sampleWorkspace(database.db, ROOT)
  task = sampleTask(database.db, workspace.id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  rmSync(`${HOME}/src`, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const BOTH_MODES = [PermissionMode.AllowAll, PermissionMode.AskBeforeEdits]
const FOR_TASK: PermissionDecision = { kind: PermissionDecisionKind.AllowForTask }
const FOR_WORKSPACE: PermissionDecision = { kind: PermissionDecisionKind.AllowForWorkspace }
const ONCE: PermissionDecision = { kind: PermissionDecisionKind.AllowOnce }
const DENY: PermissionDecision = { kind: PermissionDecisionKind.Deny }
const ALLOWED_BY_YOU: ToolStartDecision = { behavior: ToolPermissionBehavior.Allow, byUser: true }
const WITHDRAWN: ToolStartDecision = {
  behavior: ToolPermissionBehavior.Deny,
  message: PERMISSION_WITHDRAWN_NOTE,
  byUser: false,
}

const taskTarget = (id = task.id): SandboxGrantTarget => ({ scope: SandboxGrantScope.Task, taskId: id })
const workspaceTarget = (id = workspace.id) => ({ scope: SandboxGrantScope.Workspace, workspaceId: id }) as const
const GLADE_WIDE = { scope: SandboxGrantScope.Glade } as const

function current(id = task.id): Task {
  const found = getTask(database.db, id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

async function setMode(permissionMode: PermissionMode, id = task.id): Promise<void> {
  await glade.invoke(CommandName.TasksUpdate, { id, patch: { permissionMode } })
  await settle()
}

/** An init that names the session's servers, as the SDK does at the start of each turn. */
function init(servers: readonly McpServerOrigin[] = [], tools: readonly string[] = []): unknown {
  const base = sdk.init(`session-${task.id}`) as Record<string, unknown>
  return {
    ...base,
    tools: ['Bash', 'Read', ...tools],
    mcp_servers: servers.map(({ name, source }) => ({ name, status: 'connected', source })),
  }
}

/** Sends a message, and has the task's session start its turn. */
async function startTurn(id = task.id, first: unknown = sdk.init(`session-${id}`)): Promise<FakeAgentSession> {
  await glade.invoke(CommandName.TasksSend, { id, text: 'Look up the retry policy.' })
  const session = backend.session
  session.emit(first)
  await settle()
  return session
}

/** A call on its way to running: what the hook decided of it, once it has, and whether it has yet. */
interface Started {
  readonly decision: Promise<ToolStartDecision | null>
  readonly abort: () => void
  readonly settled: () => boolean
}

interface Caller {
  /** The server the tool is on, as the hook names it; none for a tool that isn't an MCP server's, or left unsaid. */
  readonly mcpServer?: McpServerOrigin | null
  readonly agentId?: string | null
  /** The `Agent` call of the subagent making the call. */
  readonly parent?: string
}

/**
 * The agent calls a tool, and the session's `PreToolUse` hook hears of it before anything else: the `tool_use`, then
 * the hook. Claude Code is never asked (`canUseTool`): a rule in the user's settings let the call through.
 */
async function starts(
  session: FakeAgentSession,
  toolUseId: string,
  toolName: string,
  input: ToolInput = {},
  { mcpServer = null, agentId = null, parent }: Caller = {},
): Promise<Started> {
  session.emit(sdk.toolUse(toolUseId, toolName, { ...input }, parent ?? null))
  await settle()
  const started = session.startTool({ toolName, toolUseId, input, agentId, mcpServer })
  let settled = false
  void started.decision.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await settle()
  return {
    decision: started.decision,
    abort: () => {
      started.abort()
    },
    settled: () => settled,
  }
}

function requests(id = task.id): PermissionRequest[] {
  return listPermissionRequests(database.db, id)
}

function only(toolUseId: string, id = task.id): PermissionRequest {
  const found = requests(id).find((request) => request.toolUseId === toolUseId)
  if (found === undefined) throw new Error(`No request for ${toolUseId}`)
  return found
}

async function answer(toolUseId: string, decision: PermissionDecision, id = task.id): Promise<void> {
  await glade.invoke(CommandName.PermissionsAnswer, { id: only(toolUseId, id).id, decision })
  await settle()
}

function grantsOf(target: SandboxGrantTarget): Grant[] {
  return listSandboxGrants(database.db, target).map(({ grant }) => grant)
}

function grant(target: SandboxGrantTarget, granted: Grant): void {
  addSandboxGrant(database.db, { target, grant: granted })
}

function marks(): Record<string, unknown> {
  return Object.fromEntries(listPermissionMarks(database.db, task.id).map((mark) => [mark.toolUseId, mark.outcome]))
}

describe('an MCP server Glade doesn’t build', () => {
  it.each(BOTH_MODES)(
    'asks before any of its tools runs, in %s, though a rule in the settings allows it',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()

      const search = await starts(session, 'toolu_search', SEARCH, { query: 'retry policy' }, { mcpServer: DOCS })

      // The call waits on a card, though Claude Code was never asked about it.
      expect(search.settled()).toBe(false)
      expect(only('toolu_search')).toMatchObject({
        state: PermissionRequestState.Open,
        toolName: SEARCH,
        input: { query: 'retry policy' },
        agentId: null,
        suppressAlwaysAllowRule: true,
        sandbox: DOCS_ASK,
      })
      expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

      await answer('toolu_search', FOR_TASK)

      await expect(search.decision).resolves.toEqual(ALLOWED_BY_YOU)
      expect(only('toolu_search')).toMatchObject({
        state: PermissionRequestState.Allowed,
        grantedScope: SandboxGrantScope.Task,
        grantedRule: null,
      })
      expect(grantsOf(taskTarget())).toEqual([DOCS_GRANT])
      expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    },
  )

  it('never asks for Glade’s own tools, in either mode', async () => {
    updateSettings(database.db, { controlEnabled: true })
    for (const mode of BOTH_MODES) {
      await setMode(mode)
      const session = await startTurn()

      const title = await starts(
        session,
        `toolu_title_${mode}`,
        'mcp__glade__set_title',
        { title: 'Retries' },
        { mcpServer: GLADE },
      )
      const tasks = await starts(
        session,
        `toolu_tasks_${mode}`,
        'mcp__glade-control__list_tasks',
        {},
        { mcpServer: CONTROL },
      )
      const made = await starts(
        session,
        `toolu_make_${mode}`,
        'mcp__glade-control__create_task',
        {},
        { mcpServer: CONTROL },
      )

      // Left to Claude Code, each as it always was: `glade`'s are pre-approved, the control tools go by the mode.
      for (const call of [title, tasks, made]) await expect(call.decision).resolves.toBeNull()
      session.emit(sdk.result('Done.'))
      await settle()
    }
    expect(requests()).toEqual([])
    expect(marks()).toEqual({})
    // And asked by Claude Code, as it does in a sandboxed session, the control tools are decided as before.
    const session = await startTurn()
    const read = session.requestPermission({
      toolUseId: 'toolu_list',
      toolName: 'mcp__glade-control__list_tasks',
      input: {},
      mcpServer: CONTROL,
    })
    await expect(read.answer).resolves.toEqual({ behavior: ToolPermissionBehavior.Allow, byUser: false })
    const write = session.requestPermission({
      toolUseId: 'toolu_create',
      toolName: 'mcp__glade-control__create_task',
      input: {},
      mcpServer: CONTROL,
    })
    await settle()
    expect(only('toolu_create')).toMatchObject({ state: PermissionRequestState.Open, sandbox: null })
    write.abort()
  })

  it('is one grant for the whole server: its other tools run unasked once it’s allowed for the task', async () => {
    const session = await startTurn()
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    await answer('toolu_search', FOR_TASK)
    await search.decision

    const read = await starts(session, 'toolu_read', READ, { id: 'doc_42' }, { mcpServer: DOCS })
    const again = await starts(session, 'toolu_again', SEARCH, { query: 'backoff' }, { mcpServer: DOCS })

    await expect(read.decision).resolves.toBeNull()
    await expect(again.decision).resolves.toBeNull()
    expect(requests()).toHaveLength(1)
    // Each row says whose grant let it through.
    const granted = { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Task, ask: DOCS_ASK }
    expect(marks()).toEqual({ toolu_read: granted, toolu_again: granted })
    // Claude Code asks about it all the same, in a sandboxed session's Allow all: it goes ahead.
    const asked = session.requestPermission({
      toolUseId: 'toolu_read',
      toolName: READ,
      input: { id: 'doc_42' },
      mcpServer: DOCS,
    })
    await expect(asked.answer).resolves.toEqual({ behavior: ToolPermissionBehavior.Allow, byUser: false })
    // Another server is another grant.
    const issue = await starts(session, 'toolu_issue', ISSUE, {}, { mcpServer: TRACKER })
    expect(issue.settled()).toBe(false)
    expect(only('toolu_issue').sandbox).toEqual(TRACKER_ASK)
  })

  it('allowed for the task, covers that task alone', async () => {
    const other = sampleTask(database.db, workspace.id)
    const session = await startTurn()
    const theirs = await startTurn(other.id)
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    await answer('toolu_search', FOR_TASK)
    await search.decision

    const asked = await starts(theirs, 'toolu_theirs', SEARCH, {}, { mcpServer: DOCS })

    expect(asked.settled()).toBe(false)
    expect(only('toolu_theirs', other.id).sandbox).toEqual(DOCS_ASK)
    expect(grantsOf(workspaceTarget())).toEqual([])
  })

  it('allowed for the workspace, covers every task in it, running ones included, and no other workspace’s', async () => {
    const other = sampleTask(database.db, workspace.id)
    const elsewhere = sampleTask(database.db, sampleWorkspace(database.db, OTHER_ROOT).id)
    const session = await startTurn()
    const theirs = await startTurn(other.id)
    const far = await startTurn(elsewhere.id)
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })

    await answer('toolu_search', FOR_WORKSPACE)

    await expect(search.decision).resolves.toEqual(ALLOWED_BY_YOU)
    expect(only('toolu_search').grantedScope).toBe(SandboxGrantScope.Workspace)
    expect(grantsOf(workspaceTarget())).toEqual([DOCS_GRANT])
    expect(grantsOf(taskTarget())).toEqual([])
    // Settings hears of it at once.
    expect(events).toContainEqual({
      type: EventType.SandboxGrantsChanged,
      target: workspaceTarget(),
      grants: [DOCS_GRANT],
    })
    // No session was restarted for it.
    expect(backend.sessions).toEqual([session, theirs, far])
    const live = await starts(theirs, 'toolu_theirs', READ, {}, { mcpServer: DOCS })
    await expect(live.decision).resolves.toBeNull()
    expect(requests(other.id)).toEqual([])
    const asked = await starts(far, 'toolu_far', READ, {}, { mcpServer: DOCS })
    expect(asked.settled()).toBe(false)
    expect(only('toolu_far', elsewhere.id).sandbox).toEqual(DOCS_ASK)
  })

  it('granted Glade-wide in Settings, covers every workspace, live', async () => {
    const elsewhere = sampleTask(database.db, sampleWorkspace(database.db, OTHER_ROOT).id)
    const session = await startTurn()
    const far = await startTurn(elsewhere.id)

    await glade.invoke(CommandName.SandboxAddGrant, { target: GLADE_WIDE, grant: DOCS_GRANT })

    for (const [live, id] of [
      [session, 'toolu_here'],
      [far, 'toolu_there'],
    ] as const) {
      const call = await starts(live, id, SEARCH, {}, { mcpServer: DOCS })
      await expect(call.decision).resolves.toBeNull()
    }
    expect(requests()).toEqual([])
    expect(requests(elsewhere.id)).toEqual([])
    expect(marks()).toEqual({
      toolu_here: { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Glade, ask: DOCS_ASK },
    })
  })

  it('denied, doesn’t run, passes the note on, and stays denied for the rest of the turn without asking again', async () => {
    const session = await startTurn()
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })

    await answer('toolu_search', { kind: PermissionDecisionKind.Deny, note: '  Use the local docs.  ' })

    await expect(search.decision).resolves.toMatchObject({
      behavior: ToolPermissionBehavior.Deny,
      message: expect.stringContaining('Use the local docs.') as unknown,
      byUser: true,
    })
    expect(only('toolu_search')).toMatchObject({
      state: PermissionRequestState.Denied,
      denyNote: 'Use the local docs.',
    })
    expect(grantsOf(taskTarget())).toEqual([])

    // Another tool of the server, and a subagent's call: the same answer, with no card.
    const read = await starts(session, 'toolu_read', READ, {}, { mcpServer: DOCS })
    const sub = await starts(session, 'toolu_sub', SEARCH, {}, { mcpServer: DOCS, agentId: 'ac2cfaf3cec2364e5' })
    for (const call of [read, sub]) {
      await expect(call.decision).resolves.toEqual({
        behavior: ToolPermissionBehavior.Deny,
        message: alreadyDeniedMessage('Use the local docs.'),
        byUser: false,
      })
    }
    expect(requests()).toHaveLength(1)
    // Another server isn't covered by it.
    const issue = await starts(session, 'toolu_issue', ISSUE, {}, { mcpServer: TRACKER })
    expect(issue.settled()).toBe(false)
    await answer('toolu_issue', DENY)

    // The next turn may ask again.
    session.emit(sdk.result('I used the local docs.'))
    await settle()
    const next = await startTurn()
    const later = await starts(next, 'toolu_later', SEARCH, {}, { mcpServer: DOCS })
    expect(later.settled()).toBe(false)
    expect(only('toolu_later').state).toBe(PermissionRequestState.Open)
  })

  it('can’t be allowed just once: only for the task or the workspace', async () => {
    const session = await startTurn()
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })

    await expect(
      glade.invoke(CommandName.PermissionsAnswer, { id: only('toolu_search').id, decision: ONCE }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })

    expect(search.settled()).toBe(false)
    expect(only('toolu_search').state).toBe(PermissionRequestState.Open)
  })

  it('a task rule for one of its tools, from the ask mode, doesn’t stand in for the grant', async () => {
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: SEARCH } })
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'mcp__claude_ai_Acme_Docs' } })
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()

    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })

    expect(search.settled()).toBe(false)
    expect(only('toolu_search').sandbox).toEqual(DOCS_ASK)
  })

  it('asks the same way when Claude Code asks about the call itself, and a hook that let it through answers that too', async () => {
    const session = await startTurn()
    // No hook heard of this one: Claude Code asks, as it does in a sandboxed session's Allow all.
    session.emit(sdk.toolUse('toolu_issue', ISSUE, { title: 'Retries' }))
    await settle()
    const asked = session.requestPermission({
      toolUseId: 'toolu_issue',
      toolName: ISSUE,
      input: { title: 'Retries' },
      mcpServer: TRACKER,
    })
    await settle()
    expect(only('toolu_issue').sandbox).toEqual(TRACKER_ASK)
    await answer('toolu_issue', FOR_TASK)
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)

    // One the hook put a card up for: Claude Code asking about it afterwards gets the same answer, and no second card.
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    await answer('toolu_search', FOR_TASK)
    await search.decision
    const after = session.requestPermission({ toolUseId: 'toolu_search', toolName: SEARCH, input: {}, mcpServer: DOCS })
    await expect(after.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(requests()).toHaveLength(2)
  })

  it('once granted, asks per call in the ask mode, as with the sandbox off, and marks nothing itself', async () => {
    grant(taskTarget(), DOCS_GRANT)
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()

    // The hook leaves it to Claude Code.
    const search = await starts(session, 'toolu_search', SEARCH, { query: 'retries' }, { mcpServer: DOCS })
    await expect(search.decision).resolves.toBeNull()
    expect(marks()).toEqual({})
    // Which asks, and the card is the ask mode's own: Allow once, or the tool for the task.
    const asked = session.requestPermission({
      toolUseId: 'toolu_search',
      toolName: SEARCH,
      input: { query: 'retries' },
      mcpServer: DOCS,
    })
    await settle()
    expect(only('toolu_search')).toMatchObject({ state: PermissionRequestState.Open, sandbox: null })
    await answer('toolu_search', ONCE)
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('names the subagent whose call it is', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Read the docs', prompt: 'Read the docs.' }))
    await settle()

    const search = await starts(
      session,
      'toolu_search',
      SEARCH,
      {},
      {
        mcpServer: DOCS,
        agentId: 'ac2cfaf3cec2364e5',
        parent: 'toolu_agent',
      },
    )

    expect(search.settled()).toBe(false)
    expect(only('toolu_search')).toMatchObject({ agentId: 'ac2cfaf3cec2364e5', sandbox: DOCS_ASK })
    await answer('toolu_search', FOR_TASK)
    await expect(search.decision).resolves.toEqual(ALLOWED_BY_YOU)
    // The grant is the task's: the agent's own calls are covered too.
    const own = await starts(session, 'toolu_own', READ, {}, { mcpServer: DOCS })
    await expect(own.decision).resolves.toBeNull()
  })

  it('gets the plain card when its name is one no grant can keep: allowed once, or denied', async () => {
    const session = await startTurn()

    const odd = await starts(session, 'toolu_odd', 'mcp__', { x: 1 })

    expect(odd.settled()).toBe(false)
    expect(only('toolu_odd')).toMatchObject({ sandbox: null, suppressAlwaysAllowRule: true })
    await expect(
      glade.invoke(CommandName.PermissionsAnswer, { id: only('toolu_odd').id, decision: FOR_TASK }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    await answer('toolu_odd', ONCE)
    await expect(odd.decision).resolves.toEqual(ALLOWED_BY_YOU)
    // Nothing was granted: the next call asks again.
    const again = await starts(session, 'toolu_odd2', 'mcp__', { x: 2 })
    expect(again.settled()).toBe(false)
  })
})

describe('a server whose name matches Glade’s own', () => {
  it.each(BOTH_MODES)('asks like any other, in %s: only the in-process server is Glade’s', async (mode) => {
    await setMode(mode)
    const session = await startTurn()

    // A `glade` from the user's config, the repository's `.mcp.json`, or one the hook says nothing of.
    const user = await starts(
      session,
      'toolu_user',
      'mcp__glade__set_title',
      { title: 'x' },
      { mcpServer: { name: 'glade', source: 'user' } },
    )

    expect(user.settled()).toBe(false)
    expect(only('toolu_user').sandbox).toEqual({ kind: SandboxAskKind.McpServer, server: 'glade', name: 'glade' })
    await answer('toolu_user', DENY)
    await user.decision
    const unsaid = await starts(session, 'toolu_unsaid', 'mcp__glade__ask', {})
    await expect(unsaid.decision).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: false })
    // Glade's own, in the same turn, never asked and never denied.
    const own = await starts(session, 'toolu_own', 'mcp__glade__set_title', { title: 'x' }, { mcpServer: GLADE })
    await expect(own.decision).resolves.toBeNull()
  })

  it('granted, opens that server and nothing of Glade’s that isn’t already open', async () => {
    grant(taskTarget(), { kind: SandboxGrantKind.McpServer, server: 'glade-control', name: 'glade-control' })
    const session = await startTurn()

    // With the control switch off the session has no in-process `glade-control`: one by that name is someone else's.
    const foreign = await starts(
      session,
      'toolu_foreign',
      'mcp__glade-control__delete_task',
      {},
      { mcpServer: { name: 'glade-control', source: 'local' } },
    )
    await expect(foreign.decision).resolves.toBeNull()
    // Even one that says it's in-process isn't Glade's unless the session was given it: it still needed the grant.
    const claimed = await starts(
      session,
      'toolu_claimed',
      'mcp__other__x',
      {},
      { mcpServer: { name: 'other', source: 'sdk' } },
    )
    expect(claimed.settled()).toBe(false)
    expect(only('toolu_claimed').sandbox).toEqual({ kind: SandboxAskKind.McpServer, server: 'other', name: 'other' })
  })
})

describe('a server with odd characters in its name', () => {
  it('is granted by the key its tools carry, and shown by the name it was reported under', async () => {
    const odd: McpServerOrigin = { name: 'Sam’s notes/ü (work)', source: 'user' }
    const tool = 'mcp__Sam_s_notes____work___search'
    const session = await startTurn()

    const search = await starts(session, 'toolu_search', tool, {}, { mcpServer: odd })

    const asked = { kind: SandboxAskKind.McpServer, server: 'Sam_s_notes____work_', name: 'Sam’s notes/ü (work)' }
    expect(only('toolu_search').sandbox).toEqual(asked)
    await answer('toolu_search', FOR_WORKSPACE)
    await search.decision
    expect(grantsOf(workspaceTarget())).toEqual([{ ...asked, kind: SandboxGrantKind.McpServer }])
    const again = await starts(session, 'toolu_again', 'mcp__Sam_s_notes____work___read', {}, { mcpServer: odd })
    await expect(again.decision).resolves.toBeNull()
    // A server whose key only starts the same is another server.
    const other = await starts(
      session,
      'toolu_other',
      'mcp__Sam_s_notes__search',
      {},
      { mcpServer: { name: 'Sam’s notes', source: 'user' } },
    )
    expect(other.settled()).toBe(false)
    expect(only('toolu_other').sandbox).toEqual({
      kind: SandboxAskKind.McpServer,
      server: 'Sam_s_notes',
      name: 'Sam’s notes',
    })
  })

  it('never shows a name’s control or text-direction characters, and tells two servers with two underscores apart', async () => {
    const session = await startTurn()

    const spoof = await starts(
      session,
      'toolu_spoof',
      'mcp__docs_____read',
      {},
      { mcpServer: { name: 'docs‮\n\u0007', source: 'project' } },
    )
    expect(only('toolu_spoof').sandbox).toEqual({ kind: SandboxAskKind.McpServer, server: 'docs___', name: 'docs' })
    await answer('toolu_spoof', DENY)
    await spoof.decision

    // `a__b` and `a` both have a tool named `mcp__a__b__c`-ish: the server the hook names is the one asked for.
    const nested = await starts(
      session,
      'toolu_nested',
      'mcp__a__b__c',
      {},
      { mcpServer: { name: 'a__b', source: 'user' } },
    )
    expect(only('toolu_nested').sandbox).toEqual({ kind: SandboxAskKind.McpServer, server: 'a__b', name: 'a__b' })
    await answer('toolu_nested', FOR_TASK)
    await nested.decision
    const short = await starts(session, 'toolu_short', 'mcp__a__b__c', {}, { mcpServer: { name: 'a', source: 'user' } })
    expect(short.settled()).toBe(false)
    expect(only('toolu_short').sandbox).toEqual({ kind: SandboxAskKind.McpServer, server: 'a', name: 'a' })
  })
})

describe('one card per server', () => {
  it('holds every call to the server on the one card, and lets them all through once it’s allowed', async () => {
    const session = await startTurn()

    // Three tools of the server in one message, and a subagent's call.
    const first = await starts(session, 'toolu_1', SEARCH, { query: 'a' }, { mcpServer: DOCS })
    const second = await starts(session, 'toolu_2', READ, { id: 'b' }, { mcpServer: DOCS })
    const third = await starts(session, 'toolu_3', SEARCH, { query: 'c' }, { mcpServer: DOCS })
    const sub = await starts(session, 'toolu_4', READ, {}, { mcpServer: DOCS, agentId: 'ac2cfaf3cec2364e5' })

    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_1'])
    for (const call of [first, second, third, sub]) expect(call.settled()).toBe(false)

    await answer('toolu_1', FOR_TASK)

    await expect(first.decision).resolves.toEqual(ALLOWED_BY_YOU)
    // The others are left to Claude Code, as any call a grant covers, each marked as the task's grant's.
    for (const call of [second, third, sub]) await expect(call.decision).resolves.toBeNull()
    expect(requests()).toHaveLength(1)
    const granted = { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Task, ask: DOCS_ASK }
    expect(marks()).toEqual({ toolu_2: granted, toolu_3: granted, toolu_4: granted })
  })

  it('denies them all with the one answer when it’s denied', async () => {
    const session = await startTurn()
    const first = await starts(session, 'toolu_1', SEARCH, {}, { mcpServer: DOCS })
    const second = await starts(session, 'toolu_2', READ, {}, { mcpServer: DOCS })
    const third = await starts(session, 'toolu_3', READ, {}, { mcpServer: DOCS })

    await answer('toolu_1', { kind: PermissionDecisionKind.Deny, note: 'Not this one.' })

    await expect(first.decision).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: true })
    for (const call of [second, third]) {
      await expect(call.decision).resolves.toEqual({
        behavior: ToolPermissionBehavior.Deny,
        message: alreadyDeniedMessage('Not this one.'),
        byUser: false,
      })
    }
    expect(requests()).toHaveLength(1)
  })

  it('opens a card for each of two servers in one turn, each answered for itself', async () => {
    const session = await startTurn()

    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    const issue = await starts(session, 'toolu_issue', ISSUE, {}, { mcpServer: TRACKER })
    const read = await starts(session, 'toolu_read', READ, {}, { mcpServer: DOCS })

    expect(requests().map(({ toolUseId, sandbox }) => [toolUseId, sandbox])).toEqual([
      ['toolu_search', DOCS_ASK],
      ['toolu_issue', TRACKER_ASK],
    ])
    expect(current().awaitingPermission).toBe(true)

    // The second server first: the first one's calls still wait.
    await answer('toolu_issue', { kind: PermissionDecisionKind.Deny, note: 'No tickets.' })
    await expect(issue.decision).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: true })
    expect(search.settled()).toBe(false)
    expect(read.settled()).toBe(false)
    expect(current().awaitingPermission).toBe(true)

    await answer('toolu_search', FOR_WORKSPACE)
    await expect(search.decision).resolves.toEqual(ALLOWED_BY_YOU)
    await expect(read.decision).resolves.toBeNull()
    expect(grantsOf(workspaceTarget())).toEqual([DOCS_GRANT])
    expect(current()).toMatchObject({ awaitingPermission: false, activity: TaskActivity.Working })
    // The denial of the one says nothing of the other.
    const more = await starts(session, 'toolu_more', ISSUE, {}, { mcpServer: TRACKER })
    await expect(more.decision).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: alreadyDeniedMessage('No tickets.'),
      byUser: false,
    })
  })

  it('asks in each of two tasks that reach the same server, and a workspace grant from one covers the other’s later calls', async () => {
    const other = sampleTask(database.db, workspace.id)
    const session = await startTurn()
    const theirs = await startTurn(other.id)

    const mine = await starts(session, 'toolu_mine', SEARCH, {}, { mcpServer: DOCS })
    const yours = await starts(theirs, 'toolu_yours', SEARCH, {}, { mcpServer: DOCS })
    const waiting = await starts(theirs, 'toolu_waiting', READ, {}, { mcpServer: DOCS })

    // A card in each task: a card is a task's own.
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_mine'])
    expect(requests(other.id).map(({ toolUseId }) => toolUseId)).toEqual(['toolu_yours'])

    await answer('toolu_mine', FOR_WORKSPACE)
    await expect(mine.decision).resolves.toEqual(ALLOWED_BY_YOU)
    // The other task's card is still its own to answer; denied there, its call doesn't run.
    expect(yours.settled()).toBe(false)
    await answer('toolu_yours', DENY, other.id)
    await expect(yours.decision).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: true })
    // The call that waited on that card finds the workspace's grant in force, as every later call does.
    await expect(waiting.decision).resolves.toBeNull()
    const later = await starts(theirs, 'toolu_later', SEARCH, {}, { mcpServer: DOCS })
    await expect(later.decision).resolves.toBeNull()
    expect(grantsOf(workspaceTarget())).toEqual([DOCS_GRANT])
  })

  it('withdraws the calls waiting on a card when the turn is stopped: none asks for itself', async () => {
    const session = await startTurn()
    const first = await starts(session, 'toolu_1', SEARCH, {}, { mcpServer: DOCS })
    const second = await starts(session, 'toolu_2', READ, {}, { mcpServer: DOCS })
    const third = await starts(session, 'toolu_3', READ, {}, { mcpServer: DOCS })

    const stopped = glade.invoke(CommandName.TasksStop, { id: task.id })
    await settle()

    for (const call of [first, second, third]) await expect(call.decision).resolves.toEqual(WITHDRAWN)
    expect(requests().map(({ toolUseId, state }) => [toolUseId, state])).toEqual([
      ['toolu_1', PermissionRequestState.Withdrawn],
    ])
    expect(grantsOf(taskTarget())).toEqual([])
    session.emit(sdk.abortedResult('aborted_tools'))
    await stopped
  })

  it('has the next call ask for itself when the card it waited on went away with its own call', async () => {
    const session = await startTurn()
    const first = await starts(session, 'toolu_1', SEARCH, {}, { mcpServer: DOCS })
    const second = await starts(session, 'toolu_2', READ, {}, { mcpServer: DOCS })
    const third = await starts(session, 'toolu_3', READ, {}, { mcpServer: DOCS })

    // The SDK cancels the call whose card it is, and one of the two waiting on it.
    third.abort()
    first.abort()
    await settle()

    await expect(first.decision).resolves.toEqual(WITHDRAWN)
    await expect(third.decision).resolves.toEqual(WITHDRAWN)
    // The other still needs an answer: a card of its own.
    expect(second.settled()).toBe(false)
    expect(requests().map(({ toolUseId, state }) => [toolUseId, state])).toEqual([
      ['toolu_1', PermissionRequestState.Withdrawn],
      ['toolu_2', PermissionRequestState.Open],
    ])
    await answer('toolu_2', FOR_TASK)
    await expect(second.decision).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('leaves a background subagent’s call waiting when the turn is stopped: it asks for itself', async () => {
    const session = await startTurn()
    for (const message of sdk.backgroundLaunch('toolu_agent', 'a7c2e91f04b3d8a1', 'Read the docs'))
      session.emit(message)
    await settle()
    const first = await starts(session, 'toolu_1', SEARCH, {}, { mcpServer: DOCS })
    const theirs = await starts(
      session,
      'toolu_bg',
      READ,
      {},
      {
        mcpServer: DOCS,
        agentId: 'a7c2e91f04b3d8a1',
        parent: 'toolu_agent',
      },
    )

    const stopped = glade.invoke(CommandName.TasksStop, { id: task.id })
    await settle()

    await expect(first.decision).resolves.toEqual(WITHDRAWN)
    expect(theirs.settled()).toBe(false)
    expect(only('toolu_bg')).toMatchObject({ state: PermissionRequestState.Open, sandbox: DOCS_ASK })
    session.emit(sdk.abortedResult('aborted_tools'))
    await stopped
    await answer('toolu_bg', FOR_TASK)
    await expect(theirs.decision).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('withdraws what waits on a card when the session closes', async () => {
    const session = await startTurn()
    const first = await starts(session, 'toolu_1', SEARCH, {}, { mcpServer: DOCS })
    const second = await starts(session, 'toolu_2', READ, {}, { mcpServer: DOCS })

    await glade.invoke(CommandName.TasksDelete, { id: task.id })
    await settle()

    await expect(first.decision).resolves.toEqual(WITHDRAWN)
    await expect(second.decision).resolves.toEqual(WITHDRAWN)
  })
})

describe('a grant removed', () => {
  it('in Settings, makes the server’s next call ask again, mid-turn', async () => {
    const session = await startTurn()
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    await answer('toolu_search', FOR_WORKSPACE)
    await search.decision
    const covered = await starts(session, 'toolu_covered', READ, {}, { mcpServer: DOCS })
    await expect(covered.decision).resolves.toBeNull()

    // The grant shows in Settings › Workspace, where it's removed, by its key alone.
    await expect(glade.invoke(CommandName.SandboxListGrants, { target: workspaceTarget() })).resolves.toEqual({
      grants: [DOCS_GRANT],
    })
    await expect(
      glade.invoke(CommandName.SandboxRemoveGrant, {
        target: workspaceTarget(),
        grant: { kind: SandboxGrantKind.McpServer, server: 'claude_ai_Acme_Docs' },
      }),
    ).resolves.toEqual({ grants: [] })

    // The same turn, the same session: the next call asks.
    expect(backend.sessions).toEqual([session])
    const next = await starts(session, 'toolu_next', READ, {}, { mcpServer: DOCS })
    expect(next.settled()).toBe(false)
    expect(only('toolu_next')).toMatchObject({ state: PermissionRequestState.Open, sandbox: DOCS_ASK })
  })

  it('while a card for another server is open, leaves that card alone', async () => {
    grant(workspaceTarget(), DOCS_GRANT)
    const session = await startTurn()
    const issue = await starts(session, 'toolu_issue', ISSUE, {}, { mcpServer: TRACKER })

    await glade.invoke(CommandName.SandboxRemoveGrant, {
      target: workspaceTarget(),
      grant: { kind: SandboxGrantKind.McpServer, server: 'claude_ai_Acme_Docs' },
    })

    expect(issue.settled()).toBe(false)
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_issue', 'toolu_search'])
    await answer('toolu_issue', FOR_TASK)
    await expect(issue.decision).resolves.toEqual(ALLOWED_BY_YOU)
    expect(search.settled()).toBe(false)
  })

  it('at one scope, leaves the server granted while another scope still grants it', async () => {
    grant(workspaceTarget(), DOCS_GRANT)
    grant(GLADE_WIDE, DOCS_GRANT)
    const session = await startTurn()

    await glade.invoke(CommandName.SandboxRemoveGrant, {
      target: workspaceTarget(),
      grant: { kind: SandboxGrantKind.McpServer, server: 'claude_ai_Acme_Docs' },
    })

    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    await expect(search.decision).resolves.toBeNull()
    expect(marks()).toEqual({
      toolu_search: { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Glade, ask: DOCS_ASK },
    })
  })
})

describe('a relaunch with the card open', () => {
  it('keeps the card, and answering it grants the server, resumes the session with it and tells the agent', async () => {
    const session = await startTurn()
    await starts(session, 'toolu_search', SEARCH, { query: 'retry policy' }, { mcpServer: DOCS })
    await starts(session, 'toolu_peer', 'SendMessage', { to: 'release-notes', message: 'Hi' })

    relaunch()

    expect(requests().map(({ state }) => state)).toEqual([PermissionRequestState.Open, PermissionRequestState.Open])
    expect(current()).toMatchObject({ awaitingPermission: true, activity: TaskActivity.Waiting })
    expect(backend.sessions).toHaveLength(0)

    await answer('toolu_search', FOR_WORKSPACE)
    // Nothing goes to the agent until every request it quit on is decided.
    expect(backend.sessions).toHaveLength(0)
    await answer('toolu_peer', { kind: PermissionDecisionKind.Deny, note: 'Not from here.' })

    expect(grantsOf(workspaceTarget())).toEqual([DOCS_GRANT])
    const resumed = backend.session
    expect(resumed.sent).toHaveLength(1)
    expect(resumed.sent[0]?.text).toContain(
      `- Your request to use the claude.ai Acme Docs MCP server (${SEARCH} call toolu_search): allowed for this workspace, and in force now.`,
    )
    expect(resumed.sent[0]?.text).toContain(
      '- Your request to message other Claude sessions (SendMessage call toolu_peer): denied. The user said: Not from here.',
    )
    // The resumed session has the grant: the call the agent makes again runs unasked. The denial still stands for the
    // turn it carries on.
    resumed.emit(sdk.init(`session-${task.id}`))
    await settle()
    const again = await starts(resumed, 'toolu_again', SEARCH, { query: 'retry policy' }, { mcpServer: DOCS })
    await expect(again.decision).resolves.toBeNull()
    const peer = await starts(resumed, 'toolu_peer2', 'SendMessage', { to: 'release-notes', message: 'Hi' })
    await expect(peer.decision).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: alreadyDeniedMessage('Not from here.'),
      byUser: false,
    })
    expect(requests()).toHaveLength(2)
  })

  it('starts a session on the grants as saved: a task’s, its workspace’s and the Glade-wide ones', async () => {
    grant(taskTarget(), CLOUD_GRANT)
    grant(workspaceTarget(), TRACKER_GRANT)
    grant(GLADE_WIDE, DOCS_GRANT)
    relaunch()
    const session = await startTurn()

    const calls = [
      await starts(session, 'toolu_cloud', 'RemoteTrigger', { action: 'list' }),
      await starts(session, 'toolu_issue', ISSUE, {}, { mcpServer: TRACKER }),
      await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS }),
    ]

    for (const call of calls) await expect(call.decision).resolves.toBeNull()
    expect(marks()).toEqual({
      toolu_cloud: { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Task, ask: CLOUD_ASK },
      toolu_issue: { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: TRACKER_ASK },
      toolu_search: { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Glade, ask: DOCS_ASK },
    })
    // Nothing of them is in the session's sandbox settings: Glade holds the session to them itself.
    const settings = JSON.stringify(session.flagSettings)
    expect(settings).not.toContain('Acme_Docs')
    expect(settings).not.toContain('acme-tracker')
  })
})

describe('SendMessage', () => {
  const SUBAGENT = 'a7c2e91f04b3d8a1'

  /** A turn in which the agent has started a background subagent, which the SDK gave an id. */
  async function withSubagent(id = task.id, sdkTaskId = SUBAGENT): Promise<FakeAgentSession> {
    const session = await startTurn(id)
    for (const message of sdk.backgroundLaunch(`toolu_agent_${sdkTaskId}`, sdkTaskId, 'Check the retry tests')) {
      session.emit(message)
    }
    await settle()
    return session
  }

  it.each(BOTH_MODES)('to one of the task’s own subagents never asks for a grant, in %s', async (mode) => {
    await setMode(mode)
    const session = await withSubagent()

    const nudge = await starts(session, 'toolu_nudge', 'SendMessage', {
      to: SUBAGENT,
      message: 'Check the backoff test too.',
    })

    await expect(nudge.decision).resolves.toBeNull()
    expect(requests()).toEqual([])
    expect(marks()).toEqual({})
    // One that has finished is still the task's own: messaging it wakes it.
    for (const message of sdk.subagentEnded(
      `toolu_agent_${SUBAGENT}`,
      SUBAGENT,
      'completed',
      'The retry tests pass.',
    )) {
      session.emit(message)
    }
    await settle()
    const wake = await starts(session, 'toolu_wake', 'SendMessage', { to: SUBAGENT, message: 'One more.' })
    await expect(wake.decision).resolves.toBeNull()
    // And a subagent messaging its sibling, by its id, is the same task still.
    const sibling = await starts(
      session,
      'toolu_sibling',
      'SendMessage',
      { to: SUBAGENT, message: 'Hi' },
      { agentId: 'ac2cfaf3cec2364e5' },
    )
    await expect(sibling.decision).resolves.toBeNull()
    expect(requests()).toEqual([])
  })

  it.each(BOTH_MODES)('to anything else asks, in %s, until other sessions are granted', async (mode) => {
    await setMode(mode)
    const session = await withSubagent()

    const peer = await starts(session, 'toolu_peer', 'SendMessage', {
      to: 'release-notes',
      message: 'Retries back off.',
    })

    expect(peer.settled()).toBe(false)
    expect(only('toolu_peer')).toMatchObject({
      toolName: 'SendMessage',
      input: { to: 'release-notes', message: 'Retries back off.' },
      suppressAlwaysAllowRule: true,
      sandbox: SESSIONS_ASK,
    })
    await answer('toolu_peer', FOR_TASK)
    await expect(peer.decision).resolves.toEqual(ALLOWED_BY_YOU)
    expect(grantsOf(taskTarget())).toEqual([SESSIONS_GRANT])
    // Granted, any target is: one grant, not one per session messaged.
    const other = await starts(session, 'toolu_other', 'SendMessage', { to: 'bridge:session_01', message: 'Hi' })
    await expect(other.decision).resolves.toBeNull()
    // And it says nothing of cloud agents.
    const cloud = await starts(session, 'toolu_cloud', 'RemoteTrigger', { action: 'list' })
    expect(cloud.settled()).toBe(false)
    expect(only('toolu_cloud').sandbox).toEqual(CLOUD_ASK)
  })

  it('to a target that only looks like one of the task’s subagents asks', async () => {
    const other = sampleTask(database.db, workspace.id)
    await withSubagent(other.id, 'b1d4f7a2c9e03561')
    const session = await withSubagent()

    const targets: unknown[] = [
      // Another task's subagent, by its real id.
      'b1d4f7a2c9e03561',
      // The subagent's description, its `Agent` call's id, and spellings of its id that aren't it.
      'Check the retry tests',
      `toolu_agent_${SUBAGENT}`,
      SUBAGENT.toUpperCase(),
      ` ${SUBAGENT}`,
      `${SUBAGENT}\n`,
      SUBAGENT.slice(0, 8),
      `${SUBAGENT}%`,
      '%',
      `bridge:${SUBAGENT}`,
      `${SUBAGENT}@elsewhere`,
      'main',
      '*',
      '',
      [SUBAGENT],
      { agentId: SUBAGENT },
      null,
    ]
    for (const [index, to] of targets.entries()) {
      const id = `toolu_like_${String(index)}`
      const call = await starts(session, id, 'SendMessage', { to, message: 'Hi' })
      // The first opens the card; the rest wait on it.
      expect(call.settled()).toBe(false)
    }
    expect(requests().map(({ toolUseId, sandbox }) => [toolUseId, sandbox])).toEqual([['toolu_like_0', SESSIONS_ASK]])
    // A call with no target at all is no subagent's either.
    const bare = await starts(session, 'toolu_bare', 'SendMessage', {})
    expect(bare.settled()).toBe(false)
    // While the real one, all along, never asks.
    const own = await starts(session, 'toolu_own', 'SendMessage', { to: SUBAGENT, message: 'Hi' })
    await expect(own.decision).resolves.toBeNull()
  })

  it('denied, stays denied for the turn, and still reaches the task’s own subagent', async () => {
    const session = await withSubagent()
    const peer = await starts(session, 'toolu_peer', 'SendMessage', { to: 'release-notes', message: 'Hi' })
    await answer('toolu_peer', { kind: PermissionDecisionKind.Deny, note: 'Not from here.' })
    await peer.decision

    const again = await starts(session, 'toolu_again', 'SendMessage', { to: 'docs-review', message: 'Hi' })
    await expect(again.decision).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: alreadyDeniedMessage('Not from here.'),
      byUser: false,
    })
    const own = await starts(session, 'toolu_own', 'SendMessage', { to: SUBAGENT, message: 'Hi' })
    await expect(own.decision).resolves.toBeNull()
  })
})

describe('RemoteTrigger', () => {
  it.each(BOTH_MODES)('asks in %s until cloud agents are granted, whatever it’s asked to do', async (mode) => {
    await setMode(mode)
    const session = await startTurn()

    const list = await starts(session, 'toolu_list', 'RemoteTrigger', { action: 'list' })
    const run = await starts(session, 'toolu_run', 'RemoteTrigger', { action: 'run', trigger_id: 'trig_01' })

    expect(requests().map(({ toolUseId, sandbox }) => [toolUseId, sandbox])).toEqual([['toolu_list', CLOUD_ASK]])
    await answer('toolu_list', FOR_WORKSPACE)
    await expect(list.decision).resolves.toEqual(ALLOWED_BY_YOU)
    await expect(run.decision).resolves.toBeNull()
    expect(grantsOf(workspaceTarget())).toEqual([CLOUD_GRANT])
    // Messaging other sessions is its own grant.
    const peer = await starts(session, 'toolu_peer', 'SendMessage', { to: 'release-notes', message: 'Hi' })
    expect(peer.settled()).toBe(false)
  })
})

describe('Settings’ MCP servers lists', () => {
  it('offer the servers a workspace’s sessions have named, and never Glade’s own', async () => {
    updateSettings(database.db, { controlEnabled: true })
    const elsewhere = sampleTask(database.db, sampleWorkspace(database.db, OTHER_ROOT).id)
    const reported = [GLADE, CONTROL, DOCS, TRACKER]
    await startTurn(task.id, init(reported, [SEARCH, ISSUE]))
    const far = await startTurn(elsewhere.id, init([GLADE, GMAIL]))
    // A server a call names counts too, though no init listed it.
    await starts(far, 'toolu_notes', 'mcp__notes__read', {}, { mcpServer: { name: 'notes', source: 'local' } })

    await expect(glade.invoke(CommandName.SandboxListReportedServers, { target: workspaceTarget() })).resolves.toEqual({
      servers: [
        { server: 'acme-tracker', name: 'acme-tracker' },
        { server: 'claude_ai_Acme_Docs', name: 'claude.ai Acme Docs' },
      ],
    })
    await expect(glade.invoke(CommandName.SandboxListReportedServers, { target: GLADE_WIDE })).resolves.toEqual({
      servers: [
        { server: 'acme-tracker', name: 'acme-tracker' },
        { server: 'claude_ai_Acme_Docs', name: 'claude.ai Acme Docs' },
        { server: 'gmail', name: 'gmail' },
        { server: 'notes', name: 'notes' },
      ],
    })
    await expect(
      glade.invoke(CommandName.SandboxListReportedServers, {
        target: { scope: SandboxGrantScope.Workspace, workspaceId: 'nowhere' },
      }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
  })

  it('keep a session’s servers once, however many turns name them', async () => {
    const session = await startTurn(task.id, init([DOCS, TRACKER]))
    session.emit(sdk.result('Done.'))
    await settle()
    await startTurn(task.id, init([TRACKER, DOCS]))

    expect(log.withMessage('mcp servers reported').map(({ fields }) => fields)).toEqual([
      { taskId: task.id, servers: ['claude_ai_Acme_Docs', 'acme-tracker'], changed: 2 },
    ])
    // One named otherwise is kept under its new name.
    session.emit(init([{ name: 'claude.ai  Acme Docs', source: 'claudeai' }], [SEARCH]))
    await settle()
    expect(listReportedServers(database.db, workspace.id)).toEqual([
      { server: 'acme-tracker', name: 'acme-tracker' },
      { server: 'claude_ai_Acme_Docs', name: 'claude.ai Acme Docs' },
    ])
  })

  it('leave out Glade’s own on a CLI that doesn’t say where a server is from, and keep them with the sandbox off', async () => {
    updateSettings(database.db, { sandboxEnabled: false, controlEnabled: true })
    const unsourced = {
      ...(init() as Record<string, unknown>),
      mcp_servers: [{ name: 'glade' }, { name: 'glade-control' }, { name: 'gmail' }],
    }

    await startTurn(task.id, unsourced)

    expect(listReportedServers(database.db, workspace.id)).toEqual([{ server: 'gmail', name: 'gmail' }])
  })

  it('add a server, or other agents, by hand: live, once each, and only one a tool’s name could carry', async () => {
    const session = await startTurn()

    await expect(
      glade.invoke(CommandName.SandboxAddGrant, {
        target: workspaceTarget(),
        grant: { ...DOCS_GRANT, name: ' claude.ai\nAcme Docs ' },
      }),
    ).resolves.toEqual({ grants: [DOCS_GRANT] })
    await expect(
      glade.invoke(CommandName.SandboxAddGrant, { target: workspaceTarget(), grant: SESSIONS_GRANT }),
    ).resolves.toEqual({
      grants: [DOCS_GRANT, SESSIONS_GRANT],
    })
    const search = await starts(session, 'toolu_search', SEARCH, {}, { mcpServer: DOCS })
    const peer = await starts(session, 'toolu_peer', 'SendMessage', { to: 'release-notes', message: 'Hi' })
    await expect(search.decision).resolves.toBeNull()
    await expect(peer.decision).resolves.toBeNull()
    expect(marks()).toEqual({
      toolu_search: { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: DOCS_ASK },
      toolu_peer: { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: SESSIONS_ASK },
    })

    // What it already has is refused, with why.
    await expect(
      glade.invoke(CommandName.SandboxAddGrant, { target: workspaceTarget(), grant: DOCS_GRANT }),
    ).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
      message: expect.stringContaining(SETTINGS_GRANT_REFUSALS.duplicateServer) as unknown,
    })
    await expect(
      glade.invoke(CommandName.SandboxAddGrant, { target: workspaceTarget(), grant: SESSIONS_GRANT }),
    ).rejects.toMatchObject({ message: expect.stringContaining(SETTINGS_GRANT_REFUSALS.duplicateAgents) as unknown })
    // And so is a server by the name it's shown under, rather than the key its tools carry.
    for (const server of ['claude.ai Acme Docs', '', 'a b', 'x'.repeat(201)]) {
      await expect(
        glade.invoke(CommandName.SandboxAddGrant, {
          target: workspaceTarget(),
          grant: { kind: SandboxGrantKind.McpServer, server, name: 'Acme Docs' },
        }),
      ).rejects.toMatchObject({
        code: BridgeErrorCode.InvalidRequest,
        message: expect.stringContaining('not an MCP server’s name') as unknown,
      })
      await expect(
        glade.invoke(CommandName.SandboxRemoveGrant, {
          target: workspaceTarget(),
          grant: { kind: SandboxGrantKind.McpServer, server },
        }),
      ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    }
    expect(grantsOf(workspaceTarget())).toEqual([DOCS_GRANT, SESSIONS_GRANT])

    // Removed, each asks again from the next call.
    await glade.invoke(CommandName.SandboxRemoveGrant, { target: workspaceTarget(), grant: SESSIONS_GRANT })
    const again = await starts(session, 'toolu_peer2', 'SendMessage', { to: 'release-notes', message: 'Hi' })
    expect(again.settled()).toBe(false)
  })
})

describe('with the sandbox off', () => {
  it('asks for no server: every call is decided as it always was', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    const session = await startTurn()

    expect(session.options.hooks?.onToolStarting).toBeUndefined()
    const hooked = session.startTool({ toolName: SEARCH, toolUseId: 'toolu_search', input: {}, mcpServer: DOCS })
    await expect(hooked.decision).resolves.toBeNull()
    // The ask mode's card for it is the ask mode's own.
    await setMode(PermissionMode.AskBeforeEdits)
    session.emit(sdk.toolUse('toolu_issue', ISSUE, {}))
    await settle()
    const asked = session.requestPermission({
      toolUseId: 'toolu_issue',
      toolName: ISSUE,
      input: {},
      mcpServer: TRACKER,
    })
    await settle()
    expect(only('toolu_issue')).toMatchObject({ state: PermissionRequestState.Open, sandbox: null })
    asked.abort()
    for (const tool of ['SendMessage', 'RemoteTrigger']) {
      session.emit(sdk.toolUse(`toolu_${tool}`, tool, {}))
      await settle()
      const call = session.requestPermission({ toolUseId: `toolu_${tool}`, toolName: tool, input: {} })
      await settle()
      expect(only(`toolu_${tool}`).sandbox).toBeNull()
      call.abort()
    }
    expect(marks()).toEqual({})
  })
})
