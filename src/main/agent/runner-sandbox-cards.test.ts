// The agent sandbox's permission cards in a running task (#450): what each boundary crossing asks for, what each
// answer grants and to whom, that the grant is in force before the call goes on, and the agent's own `request_access`.
// A fake agent session behind the real bridge, saving to a database in a temporary folder. The home folder is a
// temporary one too, so the paths the sandbox resolves are never the machine's own.
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge } from '../../shared/bridge'
import {
  PermissionDecisionKind,
  PermissionMarkKind,
  PermissionMode,
  PermissionRequestState,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type PermissionDecision,
  type PermissionMark,
  type PermissionMarkOutcome,
  type PermissionRequest,
  type Task,
  type ToolCallEvent,
  type Workspace,
} from '../../shared/domain'
import {
  FolderAccess,
  SandboxAskKind,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import { REQUEST_ACCESS_TOOL } from '../../shared/toolName'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listPermissionMarks } from '../db/repositories/permission-marks'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { listSandboxGrants } from '../db/repositories/sandbox-grants'
import { updateSettings } from '../db/repositories/settings'
import { addTaskPermissionRule, listTaskPermissionRules } from '../db/repositories/task-permission-rules'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { FOLDER_MOVED_NOTE } from '../permissions/permissions'
import { ACCESS_WITHDRAWN, AccessOutcomeKind, accessReply } from '../permissions/sandbox-ask'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { grantSandboxAccess, revokeSandboxGrant, type SandboxGrantsContext } from '../sandbox/grants'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { ToolPermissionBehavior, type ToolPermissionAnswer } from './backend'
import {
  FakeAgentBackend,
  settle,
  type AskedPermission,
  type FakeAgentSession,
  type PermissionCallFields,
  type ToolCaller,
} from './fake-backend'
import {
  alreadyDeniedMessage,
  CONNECTION_REFUSAL,
  PERMISSION_WITHDRAWN_NOTE,
  SANDBOX_FAILED_REFUSAL,
  SANDBOX_NOT_APPLIED,
  type AgentRunner,
} from './runner'
import {
  FileAccess,
  networkAccessCall,
  outsideFileCall,
  sandboxInitFailure,
  sandboxOverrideCall,
  SANDBOX_NETWORK_TOOL,
  webFetchCall,
} from './sandbox-requests'
import { sdkPermissionResult } from './sdk-backend'
import { SANDBOX_LINE } from './system-prompt'
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
/** A folder outside the workspace, under the home folder, so reading it crosses the sandbox's bounds. */
const WEB = `${HOME}/code/acme-web`
const HOST = 'registry.npmjs.org'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let notifyReply: ReturnType<typeof vi.fn<(taskId: string, text: string) => void>>

function launch(): void {
  backend = new FakeAgentBackend()
  notifyReply = vi.fn()
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
    notifyReply,
  }))
  glade = createBridge(ipc.renderer)
}

/** Quits the app, whatever it's doing, and launches it again on the same database, carrying on what it quit in. */
function relaunch(): void {
  runner.close()
  launch()
  runner.resumeInterrupted()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  mkdirSync(WEB, { recursive: true })
  mkdirSync(ROOT, { recursive: true })
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
  rmSync(`${HOME}/code`, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function current(taskId = task.id): Task {
  const found = getTask(database.db, taskId)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

async function setMode(permissionMode: PermissionMode, taskId = task.id): Promise<void> {
  await glade.invoke(CommandName.TasksUpdate, { id: taskId, patch: { permissionMode } })
  await settle()
}

/** Sends a message, and has the task's session start its turn. */
async function startTurn(taskId = task.id, text = 'Publish the client.'): Promise<FakeAgentSession> {
  await glade.invoke(CommandName.TasksSend, { id: taskId, text })
  const session = backend.session
  session.emit(sdk.init(`session-${taskId}`))
  await settle()
  return session
}

/** The agent calls a tool, and Claude Code asks about it: the `tool_use`, then `canUseTool`. */
async function callTool(
  session: FakeAgentSession,
  fields: PermissionCallFields,
  parent: string | null = null,
): Promise<AskedPermission> {
  session.emit(sdk.toolUse(fields.toolUseId, fields.toolName, { ...fields.input }, parent))
  await settle()
  const asked = session.requestPermission(fields)
  await settle()
  return asked
}

/** A command starts running: its `tool_use`, with no result yet. */
async function startCommand(
  session: FakeAgentSession,
  toolUseId: string,
  input: Record<string, unknown>,
  parent: string | null = null,
): Promise<void> {
  session.emit(sdk.toolUse(toolUseId, 'Bash', input, parent))
  await settle()
}

function requests(taskId = task.id): PermissionRequest[] {
  return listPermissionRequests(database.db, taskId)
}

function only(toolUseId: string, taskId = task.id): PermissionRequest {
  const found = requests(taskId).find((request) => request.toolUseId === toolUseId)
  if (found === undefined) throw new Error(`No request for ${toolUseId}`)
  return found
}

async function answer(toolUseId: string, decision: PermissionDecision, taskId = task.id): Promise<void> {
  await glade.invoke(CommandName.PermissionsAnswer, { id: only(toolUseId, taskId).id, decision })
  await settle()
}

function toolCall(toolUseId: string, taskId = task.id): ToolCallEvent {
  const found = listToolEvents(database.db, taskId).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No tool call ${toolUseId}`)
  return found
}

function grants(target: SandboxGrantTarget): Grant[] {
  return listSandboxGrants(database.db, target).map(({ grant }) => grant)
}

/** What granting from Settings needs: the database, the runner, and the windows to tell (nobody, here). */
const grantsContext = (): SandboxGrantsContext => ({ db: database.db, runner, emit: () => undefined })

const taskGrants = (taskId = task.id): Grant[] => grants({ scope: SandboxGrantScope.Task, taskId })
const workspaceGrants = (workspaceId = workspace.id): Grant[] =>
  grants({ scope: SandboxGrantScope.Workspace, workspaceId })

/** What a session does when interrupted, as the SDK would: its turn ends aborted. */
function interrupted(session: FakeAgentSession): () => Promise<void> {
  return () => {
    session.emit(sdk.interruptMarker(true), sdk.abortedResult('aborted_tools'))
    return Promise.resolve()
  }
}

/** Whether a promise has settled yet. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending')
  return (await Promise.race([promise, settle().then(() => pending)])) !== pending
}

/** The folders the session's commands may read and write, and what its file tools and `WebFetch` may use, now. */
function overlay(session: FakeAgentSession) {
  const last = session.flagSettings.at(-1)
  return {
    allowRead: last?.sandbox?.filesystem?.allowRead,
    allowWrite: last?.sandbox?.filesystem?.allowWrite,
    allow: last?.permissions?.allow,
    additionalDirectories: last?.permissions?.additionalDirectories,
  }
}

const ALLOWED_AT_ONCE: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: false }
const ALLOWED_BY_YOU: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: true }
const WITHDRAWN: ToolPermissionAnswer = {
  behavior: ToolPermissionBehavior.Deny,
  message: PERMISSION_WITHDRAWN_NOTE,
  byUser: false,
}
const FOR_TASK: PermissionDecision = { kind: PermissionDecisionKind.AllowForTask }
const FOR_WORKSPACE: PermissionDecision = { kind: PermissionDecisionKind.AllowForWorkspace }
const ONCE: PermissionDecision = { kind: PermissionDecisionKind.AllowOnce }
const DENY: PermissionDecision = { kind: PermissionDecisionKind.Deny }

const readOf = (toolUseId: string, path: string): PermissionCallFields =>
  outsideFileCall(toolUseId, 'Read', { file_path: path }, path, FileAccess.Read)
const writeOf = (toolUseId: string, path: string): PermissionCallFields =>
  outsideFileCall(toolUseId, 'Write', { file_path: path, content: 'x' }, path, FileAccess.Write)
const OVERRIDE = { command: 'docker compose up -d db', dangerouslyDisableSandbox: true }

const BOTH_MODES = [PermissionMode.AllowAll, PermissionMode.AskBeforeEdits]

/** The agent calls `request_access` for a path: resolves once the tool has returned, which a card holds up. */
function asksAccess(
  session: FakeAgentSession,
  toolUseId: string,
  path: string,
  access: 'read' | 'write' = 'read',
  caller: ToolCaller = {},
): Promise<void> {
  const input = { path, access, reason: 'The command needs it.' }
  const called = session.callTool(toolUseId, REQUEST_ACCESS_TOOL, input, undefined, caller)
  // One left waiting on its card when the test ends is cancelled as its session closes.
  called.catch(() => undefined)
  return called
}

/** Swaps a folder or file for a link to somewhere else, as a command with a grant above it could. */
function swapForLink(path: string, target: string): void {
  renameSync(path, `${path}.was`)
  symlinkSync(target, path)
}

describe('what each crossing asks for', () => {
  it.each(BOTH_MODES)('a command’s connection asks for the domain, on the command’s own row, in %s', async (mode) => {
    await setMode(mode)
    const session = await startTurn()
    await startCommand(session, 'toolu_install', { command: 'npm install', description: 'Install the packages' })

    const asked = session.requestPermission(networkAccessCall(HOST, 'b5a6dac2-fresh-uuid'))
    await settle()

    const [request] = requests()
    expect(request).toMatchObject({
      // The SDK asks under a fresh id: the request goes with the command running at the time.
      toolUseId: 'toolu_install',
      toolName: SANDBOX_NETWORK_TOOL,
      input: { host: HOST },
      agentId: null,
      suppressAlwaysAllowRule: true,
      sandbox: {
        kind: SandboxAskKind.Domain,
        domain: HOST,
        command: 'npm install',
        commandDescription: 'Install the packages',
      },
    })
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(await isSettled(asked.answer)).toBe(false)
  })

  it.each(BOTH_MODES)('WebFetch asks for its URL’s domain in %s', async (mode) => {
    await setMode(mode)
    const session = await startTurn()

    await callTool(session, webFetchCall('toolu_fetch', { url: 'https://Docs.Acme.dev/retries', prompt: 'Sum up.' }))

    expect(only('toolu_fetch').sandbox).toEqual({
      kind: SandboxAskKind.Domain,
      domain: 'docs.acme.dev',
      command: null,
      commandDescription: null,
    })
  })

  it.each(BOTH_MODES)(
    'a file tool asks for the folder its suggestion names, to read or to write, in %s',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()

      await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
      await callTool(session, writeOf('toolu_write', `${WEB}/src/api/client.ts`))

      expect(only('toolu_read').sandbox).toEqual({ kind: SandboxAskKind.Folder, path: WEB, access: FolderAccess.Read })
      expect(only('toolu_write').sandbox).toEqual({
        kind: SandboxAskKind.Folder,
        path: `${WEB}/src/api`,
        access: FolderAccess.ReadWrite,
      })
      for (const toolUseId of ['toolu_read', 'toolu_write']) expect(only(toolUseId).suppressAlwaysAllowRule).toBe(true)
    },
  )

  it('a file tool’s ask with no suggestion names the file’s own folder', async () => {
    const session = await startTurn()

    await callTool(session, { toolUseId: 'toolu_read', toolName: 'Read', input: { file_path: `${WEB}/README.md` } })
    await callTool(session, {
      toolUseId: 'toolu_edit',
      toolName: 'Edit',
      input: { file_path: '~/code/acme-web/docs/guide.md', old_string: 'a', new_string: 'b' },
    })

    expect(only('toolu_read').sandbox).toEqual({ kind: SandboxAskKind.Folder, path: WEB, access: FolderAccess.Read })
    expect(only('toolu_edit').sandbox).toEqual({
      kind: SandboxAskKind.Folder,
      path: `${WEB}/docs`,
      access: FolderAccess.ReadWrite,
    })
  })

  it('names the folder a link leads to, and falls back to the file’s own when a suggestion names another', async () => {
    symlinkSync(WEB, `${HOME}/code/web-link`)
    const session = await startTurn()

    await callTool(session, readOf('toolu_link', `${HOME}/code/web-link/package.json`))
    // A suggestion for a folder the file isn't in is passed over.
    await callTool(session, {
      ...readOf('toolu_odd', `${WEB}/package.json`),
      suggestions: outsideFileCall('x', 'Read', {}, `${HOME}/elsewhere/a.md`, FileAccess.Read).suggestions,
    })

    expect(only('toolu_link').sandbox).toMatchObject({ path: WEB })
    expect(only('toolu_odd').sandbox).toMatchObject({ path: WEB })
  })

  it('gives a call whose folder or host can’t be granted the plain card, allowed once or denied', async () => {
    const session = await startTurn()
    mkdirSync(`${HOME}/code/a[1]`, { recursive: true })

    const glob = await callTool(session, readOf('toolu_glob', `${HOME}/code/a[1]/x.md`))
    await callTool(session, webFetchCall('toolu_ip6', { url: 'http://[::1]:8000/', prompt: 'Read it.' }))
    await callTool(session, { toolUseId: 'toolu_nourl', toolName: 'WebFetch', input: { url: 'not a url' } })
    // A pattern of hosts isn't one a card can grant: before #510's review, this card granted every host under it.
    await callTool(session, webFetchCall('toolu_wild', { url: 'https://*.github.io/x', prompt: 'Read it.' }))

    for (const toolUseId of ['toolu_glob', 'toolu_ip6', 'toolu_nourl', 'toolu_wild']) {
      expect(only(toolUseId)).toMatchObject({ sandbox: null, suppressAlwaysAllowRule: true })
    }
    await expect(answer('toolu_wild', FOR_TASK)).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    await expect(answer('toolu_glob', FOR_WORKSPACE)).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    await answer('toolu_glob', ONCE)
    await expect(glob.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(taskGrants()).toEqual([])
  })

  it.each(BOTH_MODES)(
    'refuses a command’s connection to a host no card can name, with no card, in %s',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()
      await startCommand(session, 'toolu_aws', { command: 'aws s3 ls' })

      // A connection can't be allowed just once, and a pattern or an address is nothing a card can grant.
      const refused = { behavior: ToolPermissionBehavior.Deny, message: CONNECTION_REFUSAL, byUser: false }
      for (const [index, host] of ['*.amazonaws.com', '*', '[::1]', 'https://registry.npmjs.org/', ''].entries()) {
        const asked = session.requestPermission(networkAccessCall(host, `net-${String(index)}`))
        await expect(asked.answer).resolves.toEqual(refused)
      }
      const nameless = session.requestPermission({ ...networkAccessCall('ok.example', 'net-none'), input: {} })
      await expect(nameless.answer).resolves.toEqual(refused)

      expect(requests()).toEqual([])
      expect(taskGrants()).toEqual([])
      expect(workspaceGrants()).toEqual([])
      expect(current().awaitingPermission).toBe(false)
      // One host, by name, still asks.
      session.requestPermission(networkAccessCall('s3.amazonaws.com', 'net-ok'))
      await settle()
      expect(only('toolu_aws').sandbox).toMatchObject({ kind: SandboxAskKind.Domain, domain: 's3.amazonaws.com' })
    },
  )

  it.each(BOTH_MODES)('a command asking to leave the sandbox asks for just that in %s', async (mode) => {
    await setMode(mode)
    const session = await startTurn()

    await callTool(session, sandboxOverrideCall('toolu_out', OVERRIDE, true))
    // With an allow rule also matching, Claude Code gives no reason: the input alone says it.
    await callTool(session, { toolUseId: 'toolu_quiet', toolName: 'Bash', input: OVERRIDE })

    for (const toolUseId of ['toolu_out', 'toolu_quiet']) {
      expect(only(toolUseId)).toMatchObject({
        sandbox: { kind: SandboxAskKind.Outside },
        suppressAlwaysAllowRule: true,
      })
    }
  })

  it('a subagent’s crossing names the subagent, and its command’s connection names it by its Agent call', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Client generator', prompt: 'Generate it.' }))
    await settle()

    session.emit(sdk.toolUse('toolu_sub_write', 'Write', { file_path: `${WEB}/a.ts`, content: 'x' }, 'toolu_agent'))
    await settle()
    session.requestPermission({ ...writeOf('toolu_sub_write', `${WEB}/a.ts`), agentId: 'agent-7' })
    await startCommand(session, 'toolu_sub_npx', { command: 'npx openapi-typescript' }, 'toolu_agent')
    session.requestPermission(networkAccessCall(HOST, 'fresh-1'))
    await settle()

    expect(only('toolu_sub_write').agentId).toBe('agent-7')
    // The SDK names no subagent for a connection: the command's own `Agent` call stands in.
    expect(only('toolu_sub_npx')).toMatchObject({
      agentId: 'toolu_agent',
      sandbox: { command: 'npx openapi-typescript' },
    })
  })

  it('finds the command even when its connection asks before its tool_use has come through the stream', async () => {
    const session = await startTurn()

    // Streamed and asked about in the same breath: the request is in before the runner has read the message.
    session.emit(sdk.toolUse('toolu_install', 'Bash', { command: 'npm install' }))
    session.requestPermission(networkAccessCall(HOST, 'fresh-0'))
    await settle()

    expect(only('toolu_install').sandbox).toMatchObject({ kind: SandboxAskKind.Domain, command: 'npm install' })
  })

  it('withdraws a connection’s request whose session closed while it looked for the command', async () => {
    const session = await startTurn()

    const asked = session.requestPermission(networkAccessCall(HOST, 'fresh-0'))
    runner.close()

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(requests()).toEqual([])
  })

  it('a connection with no command running keeps the SDK’s own id, and shows no command', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_done', 'Bash', { command: 'ls' }), sdk.toolResult('toolu_done', 'a.txt'))
    session.emit(sdk.toolUse('toolu_monitor', 'Monitor', { description: 'no command here' }))
    await settle()

    session.requestPermission(networkAccessCall(HOST, 'fresh-2'))
    await settle()

    expect(only('fresh-2').sandbox).toMatchObject({ kind: SandboxAskKind.Domain, command: null })
  })

  it('with the sandbox off, a call asks as it always has: nothing of the sandbox', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()

    await callTool(session, writeOf('toolu_write', `${WEB}/a.ts`))

    expect(only('toolu_write')).toMatchObject({ sandbox: null, suppressAlwaysAllowRule: false })
    expect(session.options.systemPromptAppend).not.toContain('request_access')
  })

  it('tells a sandboxed session to ask with request_access, in its prompt', async () => {
    const session = await startTurn()

    expect(session.options.systemPromptAppend).toContain(SANDBOX_LINE)
    expect(SANDBOX_LINE).toContain('"Operation not permitted"')
    expect(SANDBOX_LINE).toContain('call request_access')
  })
})

describe('answering a folder or domain card', () => {
  it('Allow for this task grants the folder to that task only, live, and the call runs', async () => {
    const other = sampleTask(database.db, workspace.id)
    const session = await startTurn()
    const otherSession = await startTurn(other.id)
    const overlays = otherSession.flagSettings.length
    const asked = await callTool(session, readOf('toolu_read', `${WEB}/package.json`))

    await answer('toolu_read', FOR_TASK)

    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(only('toolu_read')).toMatchObject({
      state: PermissionRequestState.Allowed,
      grantedScope: SandboxGrantScope.Task,
      grantedRule: null,
    })
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read }])
    expect(taskGrants(other.id)).toEqual([])
    expect(workspaceGrants()).toEqual([])
    // Read-only: commands and file tools may read it, not write it.
    expect(overlay(session)).toEqual({
      allowRead: [ROOT, WEB],
      allowWrite: [ROOT],
      allow: [`Read(/${WEB}/**)`],
      additionalDirectories: [],
    })
    expect(otherSession.flagSettings).toHaveLength(overlays)
    expect(listTaskPermissionRules(database.db, task.id)).toEqual([])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })

    // The same folder doesn't ask again in this task, and still does in the other.
    const again = await callTool(session, readOf('toolu_again', `${WEB}/src/index.ts`))
    await expect(again.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    await callTool(otherSession, readOf('toolu_theirs', `${WEB}/package.json`))
    expect(only('toolu_theirs', other.id).state).toBe(PermissionRequestState.Open)
  })

  it('Allow for this workspace grants it to every task in the workspace, running ones included, without restarting them', async () => {
    const other = sampleTask(database.db, workspace.id)
    const elsewhere = sampleTask(database.db, sampleWorkspace(database.db, `${HOME}/src/other`).id)
    const session = await startTurn()
    const otherSession = await startTurn(other.id)
    const elsewhereSession = await startTurn(elsewhere.id)
    const asked = await callTool(session, writeOf('toolu_write', `${WEB}/src/api/client.ts`))

    await answer('toolu_write', FOR_WORKSPACE)

    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(only('toolu_write').grantedScope).toBe(SandboxGrantScope.Workspace)
    const granted = { kind: SandboxGrantKind.Folder, path: `${WEB}/src/api`, access: FolderAccess.ReadWrite }
    expect(workspaceGrants()).toEqual([granted])
    expect(taskGrants()).toEqual([])
    for (const live of [session, otherSession]) {
      expect(overlay(live)).toMatchObject({
        allowWrite: [ROOT, `${WEB}/src/api`],
        additionalDirectories: [`${WEB}/src/api`],
      })
    }
    expect(backend.sessions).toHaveLength(3)
    expect(overlay(elsewhereSession).allowWrite).toEqual([`${HOME}/src/other`])
    // The other running task reads there without asking.
    const theirs = await callTool(otherSession, readOf('toolu_theirs', `${WEB}/src/api/types.ts`))
    await expect(theirs.answer).resolves.toEqual(ALLOWED_AT_ONCE)
  })

  it('Deny grants nothing, and the agent gets the note', async () => {
    const session = await startTurn()
    const asked = await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    const overlays = session.flagSettings.length

    await answer('toolu_read', { kind: PermissionDecisionKind.Deny, note: '  Use the copy in vendor/.  ' })

    await expect(asked.answer).resolves.toMatchObject({
      behavior: ToolPermissionBehavior.Deny,
      message: expect.stringContaining('Use the copy in vendor/.') as unknown,
      byUser: true,
    })
    expect(only('toolu_read')).toMatchObject({
      state: PermissionRequestState.Denied,
      denyNote: 'Use the copy in vendor/.',
      grantedScope: null,
    })
    expect(taskGrants()).toEqual([])
    expect(workspaceGrants()).toEqual([])
    expect(session.flagSettings).toHaveLength(overlays)
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('never allows a folder or domain once', async () => {
    const session = await startTurn()
    const asked = await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    await callTool(session, webFetchCall('toolu_fetch', { url: 'https://docs.acme.dev/x', prompt: 'Read it.' }))

    for (const toolUseId of ['toolu_read', 'toolu_fetch']) {
      await expect(answer(toolUseId, ONCE)).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
      expect(only(toolUseId).state).toBe(PermissionRequestState.Open)
    }
    expect(await isSettled(asked.answer)).toBe(false)
    expect(taskGrants()).toEqual([])
  })

  it('a read grants read-only, so a later write there asks again, and upgrades it to read-write', async () => {
    const session = await startTurn()
    await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    await answer('toolu_read', FOR_TASK)

    const write = await callTool(session, writeOf('toolu_write', `${WEB}/package.json`))

    expect(only('toolu_write')).toMatchObject({
      state: PermissionRequestState.Open,
      sandbox: { kind: SandboxAskKind.Folder, path: WEB, access: FolderAccess.ReadWrite },
    })
    await answer('toolu_write', FOR_TASK)
    await expect(write.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.ReadWrite }])
    expect(overlay(session)).toEqual({
      allowRead: [ROOT, WEB],
      allowWrite: [ROOT, WEB],
      allow: [],
      additionalDirectories: [WEB],
    })
  })

  it('a domain is one grant, for commands and WebFetch alike', async () => {
    const session = await startTurn()
    await startCommand(session, 'toolu_install', { command: 'npm install' })
    const asked = session.requestPermission(networkAccessCall(HOST, 'fresh'))
    await settle()

    await answer('toolu_install', FOR_TASK)

    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Domain, domain: HOST }])
    expect(overlay(session).allow).toEqual([`WebFetch(domain:${HOST})`])
    const fetch = await callTool(session, webFetchCall('toolu_fetch', { url: `https://${HOST}/x`, prompt: 'Read.' }))
    await expect(fetch.answer).resolves.toEqual(ALLOWED_AT_ONCE)
  })

  it('has the grant in force in the asking session before the call goes on, without waiting on the others', async () => {
    const other = sampleTask(database.db, workspace.id)
    const session = await startTurn()
    const otherSession = await startTurn(other.id)
    const asked = await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    let applied: () => void = () => undefined
    session.onApplyFlagSettings = () =>
      new Promise<void>((resolve) => {
        applied = resolve
      })
    // The other session never answers: the card doesn't wait on it.
    otherSession.onApplyFlagSettings = () => new Promise<void>(() => undefined)

    await answer('toolu_read', FOR_WORKSPACE)

    // Answered, and the overlay sent, but the call still waits on the session taking it.
    expect(only('toolu_read').state).toBe(PermissionRequestState.Allowed)
    expect(overlay(session).allowRead).toEqual([ROOT, WEB])
    expect(await isSettled(asked.answer)).toBe(false)
    applied()
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('withdraws the call when its session won’t take the grant, and stops the task on the sandbox’s error', async () => {
    const session = await startTurn()
    const asked = await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings rejected'))

    await answer('toolu_read', FOR_TASK)

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(current().error?.details).toContain(`${SANDBOX_NOT_APPLIED}settings rejected`)
    // The grant stays saved: the task's next session starts with it.
    expect(taskGrants()).toHaveLength(1)
  })

  it('answers the SDK with nothing for a settings file: no rule, and no update at all', async () => {
    const session = await startTurn()
    const network = networkAccessCall(HOST, 'fresh')
    await startCommand(session, 'toolu_install', { command: 'npm install' })
    const asked = session.requestPermission(network)
    const read = await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    await answer('toolu_install', FOR_WORKSPACE)
    await answer('toolu_read', FOR_TASK)

    // The SDK suggested saving the domain's rule to the project's local settings.
    expect(JSON.stringify(only('toolu_install').suggestions)).toContain('localSettings')
    for (const call of [asked, read]) {
      const result = sdkPermissionResult(await call.answer, {})
      expect(result).toEqual({ behavior: 'allow', updatedInput: {}, decisionClassification: 'user_temporary' })
      expect(JSON.stringify(result)).not.toContain('Settings')
    }
    // Everything Glade tells the session of the grants is a flag setting, kept by the session alone.
    expect(JSON.stringify(session.flagSettings)).not.toContain('localSettings')
    for (const folder of [join(ROOT, '.claude'), join(HOME, '.claude'), join(WEB, '.claude')]) {
      expect(existsSync(folder), folder).toBe(false)
    }
  })

  it('two cards for one folder at once: granting it from one leaves the other open, and it can still be answered', async () => {
    const session = await startTurn()
    const first = await callTool(session, readOf('toolu_a', `${WEB}/a.md`))
    const second = await callTool(session, readOf('toolu_b', `${WEB}/b.md`))

    await answer('toolu_a', FOR_TASK)

    await expect(first.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(only('toolu_b').state).toBe(PermissionRequestState.Open)
    expect(await isSettled(second.answer)).toBe(false)
    // Still waiting on you, for the other.
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

    await answer('toolu_b', { kind: PermissionDecisionKind.Deny, note: 'Not that one.' })
    await expect(second.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny })
    // The denial takes nothing back.
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read }])
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('a domain card and a folder card in one turn, each answered its own way', async () => {
    const session = await startTurn()
    await startCommand(session, 'toolu_npx', { command: 'npx openapi-typescript' })
    const network = session.requestPermission(networkAccessCall(HOST, 'fresh'))
    const write = await callTool(session, writeOf('toolu_write', `${WEB}/src/api/client.ts`))

    await answer('toolu_write', FOR_WORKSPACE)
    await answer('toolu_npx', { kind: PermissionDecisionKind.Deny, note: 'No installs.' })

    await expect(write.answer).resolves.toEqual(ALLOWED_BY_YOU)
    await expect(network.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: true })
    expect(workspaceGrants()).toEqual([
      { kind: SandboxGrantKind.Folder, path: `${WEB}/src/api`, access: FolderAccess.ReadWrite },
    ])
    expect(overlay(session).allow).toEqual([])
  })

  it('Stop withdraws an open card, and nothing is granted', async () => {
    const session = await startTurn()
    const asked = await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    session.onInterrupt = interrupted(session)

    await glade.invoke(CommandName.TasksStop, { id: task.id })
    await settle()

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(only('toolu_read').state).toBe(PermissionRequestState.Withdrawn)
    expect(taskGrants()).toEqual([])
  })

  it('makes the task need you, unread and notified when you aren’t viewing it', async () => {
    const other = sampleTask(database.db, workspace.id)
    const otherSession = await startTurn(other.id)

    await callTool(otherSession, readOf('toolu_read', `${WEB}/package.json`))
    await startCommand(otherSession, 'toolu_npx', { command: 'npx x' })
    otherSession.requestPermission(networkAccessCall(HOST, 'fresh'))
    await callTool(otherSession, sandboxOverrideCall('toolu_out', OVERRIDE, true))

    expect(current(other.id)).toMatchObject({ awaitingPermission: true, unread: true, activity: TaskActivity.Waiting })
    expect(notifyReply.mock.calls).toEqual([
      [other.id, `Wants to read ${WEB}`],
      [other.id, `Wants to reach ${HOST}`],
      [other.id, 'Wants to run outside the sandbox'],
    ])
  })
})

describe('running outside the sandbox', () => {
  it.each(BOTH_MODES)('is allowed once, and asks again every time, in %s', async (mode) => {
    await setMode(mode)
    // An Allow-for-this-task rule that covers the command doesn't let it leave the sandbox either.
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Bash', ruleContent: 'docker compose *' } })
    const session = await startTurn()
    const asked = await callTool(session, sandboxOverrideCall('toolu_out', OVERRIDE, true))

    for (const remembered of [FOR_TASK, FOR_WORKSPACE]) {
      await expect(answer('toolu_out', remembered)).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    }
    expect(only('toolu_out').state).toBe(PermissionRequestState.Open)
    await answer('toolu_out', ONCE)

    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(only('toolu_out')).toMatchObject({ grantedRule: null, grantedScope: null })
    expect(taskGrants()).toEqual([])
    const again = await callTool(session, { toolUseId: 'toolu_again', toolName: 'Bash', input: OVERRIDE })
    expect(only('toolu_again').state).toBe(PermissionRequestState.Open)
    await answer('toolu_again', { kind: PermissionDecisionKind.Deny, note: 'Not this time.' })
    await expect(again.answer).resolves.toMatchObject({
      behavior: ToolPermissionBehavior.Deny,
      message: expect.stringContaining('Not this time.') as unknown,
    })
  })
})

describe('a card open when Glade quits', () => {
  it('is still there after a relaunch, and answering it grants the folder, resumes the session with it and tells the agent', async () => {
    const session = await startTurn()
    await callTool(session, readOf('toolu_read', `${WEB}/package.json`), null)
    await startCommand(session, 'toolu_npx', { command: 'npx x' })
    session.requestPermission(networkAccessCall(HOST, 'fresh'))
    await settle()

    relaunch()

    expect(requests().map(({ state }) => state)).toEqual([PermissionRequestState.Open, PermissionRequestState.Open])
    expect(current()).toMatchObject({ awaitingPermission: true, activity: TaskActivity.Waiting })
    expect(toolCall('toolu_read').state).toBe(ToolCallState.Interrupted)
    expect(toolCall('toolu_npx').state).toBe(ToolCallState.Interrupted)
    expect(backend.sessions).toHaveLength(0)

    await answer('toolu_read', FOR_TASK)
    // Nothing goes to the agent until every request it quit on is decided.
    expect(backend.sessions).toHaveLength(0)
    await answer('toolu_npx', { kind: PermissionDecisionKind.Deny, note: 'No installs.' })

    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read }])
    const resumed = backend.session
    // The resumed session's first overlay has the grant, ahead of the message that tells the agent.
    expect(overlay(resumed)).toMatchObject({ allowRead: [ROOT, WEB], allow: [`Read(/${WEB}/**)`] })
    expect(resumed.sent).toHaveLength(1)
    expect(resumed.sent[0]?.text).toContain(
      `- Your request to read ${WEB} (Read call toolu_read): allowed for this task, and in force now.`,
    )
    expect(resumed.sent[0]?.text).toContain(
      `- Your request to reach ${HOST} (${SANDBOX_NETWORK_TOOL} call toolu_npx): denied. The user said: No installs.`,
    )
    expect(current().activity).toBe(TaskActivity.Working)

    // The agent's retry goes ahead: the folder is granted.
    resumed.emit(sdk.init(`session-${task.id}`))
    await settle()
    const retry = await callTool(resumed, readOf('toolu_retry', `${WEB}/package.json`))
    await expect(retry.answer).resolves.toEqual(ALLOWED_AT_ONCE)
  })

  it('allowed for the workspace after a relaunch, reaches the other running tasks too, and says a subagent’s denial', async () => {
    const other = sampleTask(database.db, workspace.id)
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Client generator', prompt: 'Go.' }))
    await settle()
    session.emit(sdk.toolUse('toolu_write', 'Write', { file_path: `${WEB}/a.ts`, content: 'x' }, 'toolu_agent'))
    session.emit(sdk.toolUse('toolu_fetch', 'WebFetch', { url: 'https://docs.acme.dev/x' }, 'toolu_agent'))
    await settle()
    session.requestPermission({ ...writeOf('toolu_write', `${WEB}/a.ts`), agentId: 'agent-7' })
    session.requestPermission({
      ...webFetchCall('toolu_fetch', { url: 'https://docs.acme.dev/x' }),
      agentId: 'agent-7',
    })
    await settle()
    relaunch()
    const otherSession = await startTurn(other.id)

    await answer('toolu_fetch', DENY)
    await answer('toolu_write', FOR_WORKSPACE)

    expect(overlay(otherSession)).toMatchObject({ allowWrite: [ROOT, WEB] })
    const [message] = backend.session.sent
    expect(message?.text).toContain(
      `- Your subagent's request to write to ${WEB} (Write call toolu_write): allowed for this workspace, and in`,
    )
    expect(message?.text).toContain(
      "- Your subagent's request to reach docs.acme.dev (WebFetch call toolu_fetch): denied.",
    )
  })

  it('a request to run outside the sandbox, allowed once after a relaunch, lets the same command through once', async () => {
    const session = await startTurn()
    await callTool(session, sandboxOverrideCall('toolu_out', OVERRIDE, true))
    relaunch()

    await answer('toolu_out', ONCE)

    const resumed = backend.session
    expect(resumed.sent[0]?.text).toContain('call toolu_out, with input')
    expect(resumed.sent[0]?.text).toContain('allowed once.')
    resumed.emit(sdk.init(`session-${task.id}`))
    await settle()
    const retry = await callTool(resumed, sandboxOverrideCall('toolu_retry', OVERRIDE, true))
    await expect(retry.answer).resolves.toEqual(ALLOWED_BY_YOU)
    // Once: the next asks again.
    await callTool(resumed, sandboxOverrideCall('toolu_third', OVERRIDE, true))
    expect(only('toolu_third').state).toBe(PermissionRequestState.Open)
  })
})

describe('request_access', () => {
  const CACHE = `${HOME}/code/cache`

  /** The agent calls `request_access`: resolves once the tool has returned, which a card holds up. */
  function requestAccess(
    session: FakeAgentSession,
    toolUseId: string,
    input: Record<string, unknown>,
    caller: ToolCaller = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const called = session.callTool(toolUseId, REQUEST_ACCESS_TOOL, input, signal, caller)
    // One left waiting on its card when the test ends is cancelled as its session closes.
    called.catch(() => undefined)
    return called
  }

  const reading = (path: string): Record<string, unknown> => ({
    path,
    access: 'read',
    reason: '`cat` needs the shared config.',
  })
  const writing = (path: string): Record<string, unknown> => ({
    path,
    access: 'write',
    reason: '`uv sync` needs to write its download cache.',
  })

  /** What the tool told the agent, once it has returned. */
  function result(toolUseId: string): Pick<ToolCallEvent, 'output' | 'state'> {
    const { output, state } = toolCall(toolUseId)
    return { output, state }
  }

  it('opens the folder card with the reason, and waits for the answer', async () => {
    const session = await startTurn()

    const called = requestAccess(session, 'toolu_access', reading(`${WEB}/config.json`))
    await settle()

    expect(only('toolu_access')).toMatchObject({
      toolName: REQUEST_ACCESS_TOOL,
      agentId: null,
      input: { path: `${WEB}/config.json`, access: 'read', reason: '`cat` needs the shared config.' },
      description: '`cat` needs the shared config.',
      // A path that doesn't exist is asked for as it is; a file that does, by its folder (below).
      sandbox: { kind: SandboxAskKind.Folder, path: `${WEB}/config.json`, access: FolderAccess.Read },
      suppressAlwaysAllowRule: true,
    })
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(await isSettled(called)).toBe(false)
    expect(toolCall('toolu_access').state).toBe(ToolCallState.Running)
  })

  it('asks for the folder a file is in, a folder itself, and where a link leads', async () => {
    writeFileSync(`${WEB}/config.json`, '{}')
    symlinkSync(WEB, `${HOME}/code/web-link`)
    const session = await startTurn()

    void requestAccess(session, 'toolu_file', reading(`${WEB}/config.json`))
    void requestAccess(session, 'toolu_folder', writing(WEB))
    void requestAccess(session, 'toolu_link', reading(`${HOME}/code/web-link/config.json`))
    void requestAccess(session, 'toolu_tilde', writing('~/code/cache'))
    await settle()

    expect(only('toolu_file').sandbox).toMatchObject({ path: WEB, access: FolderAccess.Read })
    expect(only('toolu_folder').sandbox).toMatchObject({ path: WEB, access: FolderAccess.ReadWrite })
    expect(only('toolu_link').sandbox).toMatchObject({ path: WEB })
    expect(only('toolu_tilde').sandbox).toMatchObject({ path: CACHE, access: FolderAccess.ReadWrite })
  })

  it('allowed for the task: only that task gets it, live before the tool returns, and the result says so', async () => {
    const other = sampleTask(database.db, workspace.id)
    const session = await startTurn()
    const otherSession = await startTurn(other.id)
    const called = requestAccess(session, 'toolu_access', writing(CACHE))
    await settle()
    let applied: () => void = () => undefined
    session.onApplyFlagSettings = () =>
      new Promise<void>((resolve) => {
        applied = resolve
      })

    await answer('toolu_access', FOR_TASK)

    // The grant is saved and sent, and the tool still waits on the session taking it.
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: CACHE, access: FolderAccess.ReadWrite }])
    expect(overlay(session).allowWrite).toEqual([ROOT, CACHE])
    expect(await isSettled(called)).toBe(false)
    applied()
    await called
    await settle()

    expect(result('toolu_access')).toEqual({
      output: `Allowed for this task: you can now read and write ${CACHE}. Run the command that was blocked again.`,
      state: ToolCallState.Done,
    })
    expect(overlay(otherSession).allowWrite).toEqual([ROOT])
    expect(taskGrants(other.id)).toEqual([])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
  })

  it('allowed for the workspace: every task in it gets it live, running ones included', async () => {
    const other = sampleTask(database.db, workspace.id)
    const session = await startTurn()
    const otherSession = await startTurn(other.id)
    const called = requestAccess(session, 'toolu_access', reading(WEB))
    await settle()

    await answer('toolu_access', FOR_WORKSPACE)
    await called
    await settle()

    expect(result('toolu_access').output).toBe(
      `Allowed for this workspace: you can now read ${WEB}. Run the command that was blocked again.`,
    )
    expect(workspaceGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read }])
    for (const live of [session, otherSession]) expect(overlay(live).allowRead).toEqual([ROOT, WEB])
    expect(backend.sessions).toHaveLength(2)
  })

  it.each([
    ['with a note', { kind: PermissionDecisionKind.Deny, note: ' Use the cache in the workspace. ' }, true],
    ['without one', { kind: PermissionDecisionKind.Deny }, false],
    ['with a blank one', { kind: PermissionDecisionKind.Deny, note: '   ' }, false],
  ] as const)('denied %s: nothing is granted, and the result says so', async (_name, decision, noted) => {
    const session = await startTurn()
    const overlays = session.flagSettings.length
    const called = requestAccess(session, 'toolu_access', writing(CACHE))
    await settle()

    await answer('toolu_access', decision)
    await called
    await settle()

    const denied = `Denied: the user didn't allow ${CACHE}, so nothing was granted. Don't retry outside the sandbox.`
    expect(result('toolu_access')).toEqual({
      output: noted ? `${denied} The user said: Use the cache in the workspace.` : denied,
      state: ToolCallState.Error,
    })
    expect(taskGrants()).toEqual([])
    expect(workspaceGrants()).toEqual([])
    expect(session.flagSettings).toHaveLength(overlays)
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('a read then a write for one folder: read-only, then the write asks and upgrades it to read-write', async () => {
    const session = await startTurn()
    const read = requestAccess(session, 'toolu_read', reading(WEB))
    await settle()
    await answer('toolu_read', FOR_TASK)
    await read
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read }])

    // Reading it again needs nothing; writing does.
    await requestAccess(session, 'toolu_read_again', reading(`${WEB}/package.json`))
    const write = requestAccess(session, 'toolu_write', writing(WEB))
    await settle()

    expect(result('toolu_read_again').output).toBe(
      `${WEB}/package.json is already granted for this task with that access: nothing more to grant.`,
    )
    expect(only('toolu_write').sandbox).toMatchObject({ path: WEB, access: FolderAccess.ReadWrite })
    await answer('toolu_write', FOR_TASK)
    await write
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.ReadWrite }])
    expect(overlay(session).allowWrite).toEqual([ROOT, WEB])
  })

  it('called by a subagent: the card names it, and the grant is the task’s or the workspace’s, as answered', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Client generator', prompt: 'Go.' }))
    await settle()
    const caller = { agentId: 'agent-7', parent: 'toolu_agent' }

    const first = requestAccess(session, 'toolu_sub', writing(CACHE), caller)
    const second = requestAccess(session, 'toolu_sub_2', reading(WEB), caller)
    await settle()

    expect(only('toolu_sub').agentId).toBe('agent-7')
    expect(toolCall('toolu_sub').parentToolUseId).toBe('toolu_agent')
    await answer('toolu_sub', FOR_TASK)
    await answer('toolu_sub_2', FOR_WORKSPACE)
    await Promise.all([first, second])
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: CACHE, access: FolderAccess.ReadWrite }])
    expect(workspaceGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read }])
  })

  it('finds its call by what it asks for when Claude Code sends no id with it, each call once', async () => {
    const session = await startTurn()
    const unnamed = { agentId: 'agent-7', namesCall: false }

    void requestAccess(session, 'toolu_a', writing(CACHE), unnamed)
    void requestAccess(session, 'toolu_b', writing(CACHE), { namesCall: false })
    void requestAccess(session, 'toolu_c', reading(WEB), { namesCall: false })
    await settle()

    expect(requests().map(({ toolUseId, agentId }) => [toolUseId, agentId])).toEqual([
      ['toolu_a', 'agent-7'],
      ['toolu_b', null],
      ['toolu_c', null],
    ])
  })

  it('a call the hook never told of is the agent’s own, under an id of its own', async () => {
    const session = await startTurn()
    const { hooks } = session.options
    // As if the SDK's hook hadn't fired: only the tool's handler runs.
    if (hooks !== undefined) Reflect.deleteProperty(hooks, 'onAccessRequested')

    void requestAccess(session, 'toolu_access', writing(CACHE), { namesCall: false })
    void requestAccess(session, 'toolu_named', reading(WEB))
    await settle()

    const [unknown, named] = requests()
    expect(unknown).toMatchObject({ agentId: null, toolUseId: expect.stringMatching(/^request_access-/) as unknown })
    expect(named).toMatchObject({ agentId: null, toolUseId: 'toolu_named' })
  })

  it('answers at once, with no card, when there’s nothing to decide', async () => {
    await grantSandboxAccess(grantsContext(), {
      target: { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id },
      grant: { kind: SandboxGrantKind.Folder, path: `${HOME}/code/shared`, access: FolderAccess.Read },
    })
    await grantSandboxAccess(grantsContext(), {
      target: { scope: SandboxGrantScope.Glade },
      grant: { kind: SandboxGrantKind.Folder, path: `${HOME}/code/tools`, access: FolderAccess.ReadWrite },
    })
    const session = await startTurn()

    await requestAccess(session, 'toolu_root', writing(`${ROOT}/build/out.txt`))
    await requestAccess(session, 'toolu_shared', reading(`${HOME}/code/shared/a.md`))
    await requestAccess(session, 'toolu_tools', writing(`${HOME}/code/tools`))
    await requestAccess(session, 'toolu_etc', reading('/etc/hosts'))
    await settle()

    expect(requests()).toEqual([])
    expect(result('toolu_root').output).toContain(`${ROOT}/build/out.txt is inside the workspace, which you can`)
    expect(result('toolu_shared').output).toBe(
      `${HOME}/code/shared/a.md is already granted for this workspace with that access: nothing more to grant.`,
    )
    expect(result('toolu_tools').output).toBe(
      `${HOME}/code/tools is already granted for every workspace with that access: nothing more to grant.`,
    )
    expect(result('toolu_etc').output).toBe('You can already use /etc/hosts that way: nothing needs granting.')
    for (const id of ['toolu_root', 'toolu_shared', 'toolu_tools', 'toolu_etc']) {
      expect(result(id).state).toBe(ToolCallState.Done)
    }
    // A write to the folder granted read-only does ask.
    void requestAccess(session, 'toolu_upgrade', writing(`${HOME}/code/shared`))
    await settle()
    expect(only('toolu_upgrade').sandbox).toMatchObject({ access: FolderAccess.ReadWrite })
  })

  it('answers at once that the sandbox is off, in a session that isn’t sandboxed', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    const session = await startTurn()

    await requestAccess(session, 'toolu_access', writing(CACHE))
    await settle()

    expect(requests()).toEqual([])
    expect(result('toolu_access')).toEqual({
      output: "The sandbox is off in this session, so it didn't block anything and there's nothing to grant.",
      state: ToolCallState.Done,
    })
  })

  it('refuses a credential path outright, with no card, even inside a granted folder', async () => {
    await grantSandboxAccess(grantsContext(), {
      target: { scope: SandboxGrantScope.Task, taskId: task.id },
      grant: { kind: SandboxGrantKind.Folder, path: HOME, access: FolderAccess.ReadWrite },
    })
    const session = await startTurn()

    await requestAccess(session, 'toolu_ssh', reading('~/.ssh/id_ed25519'))
    await requestAccess(session, 'toolu_aws', writing(`${HOME}/.aws`))
    await settle()

    expect(requests()).toEqual([])
    for (const id of ['toolu_ssh', 'toolu_aws']) {
      expect(result(id).state).toBe(ToolCallState.Error)
      expect(result(id).output).toContain('is one of the credential files and folders the sandbox never opens')
    }
  })

  it.each([
    ['a relative path', { path: 'code/cache', access: 'write', reason: 'Cache.' }, 'Give the absolute path'],
    ['no reason', { path: '/x/cache', access: 'write' }, 'reason'],
    ['an empty reason', { path: '/x/cache', access: 'write', reason: '  ' }, 'The reason is empty.'],
    ['no path', { access: 'read', reason: 'Config.' }, 'path'],
    ['another access', { path: '/x/cache', access: 'execute', reason: 'Run it.' }, 'access'],
  ])('%s is a tool error, with no card', async (_name, input, problem) => {
    const session = await startTurn()

    await requestAccess(session, 'toolu_access', input)
    await settle()

    expect(requests()).toEqual([])
    expect(result('toolu_access').state).toBe(ToolCallState.Error)
    expect(result('toolu_access').output).toContain(problem)
  })

  it('says a path no grant can name can’t be granted, with no card', async () => {
    const session = await startTurn()
    mkdirSync(`${HOME}/code/loop`, { recursive: true })
    symlinkSync(`${HOME}/code/loop/b`, `${HOME}/code/loop/a`)
    symlinkSync(`${HOME}/code/loop/a`, `${HOME}/code/loop/b`)

    await requestAccess(session, 'toolu_glob', writing(`${HOME}/code/*`))
    await requestAccess(session, 'toolu_loop', reading(`${HOME}/code/loop/a/x`))
    await settle()

    expect(requests()).toEqual([])
    expect(result('toolu_glob')).toEqual({
      output: `Can't grant "${HOME}/code/*": a pattern, not a folder. Ask for a folder, by its absolute path.`,
      state: ToolCallState.Error,
    })
    expect(result('toolu_loop').output).toContain(`Can't resolve "${HOME}/code/loop/a/x"`)
  })

  it('two calls for one folder at once: each has its card, and granting from one leaves the other to answer', async () => {
    const session = await startTurn()
    const first = requestAccess(session, 'toolu_a', writing(CACHE))
    const second = requestAccess(session, 'toolu_b', writing(CACHE))
    await settle()
    expect(requests().map(({ state }) => state)).toEqual([PermissionRequestState.Open, PermissionRequestState.Open])

    await answer('toolu_a', FOR_TASK)
    await first
    expect(only('toolu_b').state).toBe(PermissionRequestState.Open)
    expect(await isSettled(second)).toBe(false)

    await answer('toolu_b', FOR_WORKSPACE)
    await second
    await settle()
    expect(result('toolu_b').output).toContain('Allowed for this workspace')
    expect(taskGrants()).toHaveLength(1)
    expect(workspaceGrants()).toHaveLength(1)
  })

  it('a call withdrawn by Stop returns that no decision was made, and grants nothing', async () => {
    const session = await startTurn()
    const called = requestAccess(session, 'toolu_access', writing(CACHE))
    // And one made of the runner itself, to see what the tool is told.
    const outcome = runner.requestAccess(
      task.id,
      { path: WEB, access: FileAccess.Read, reason: 'Config.' },
      { toolUseId: null },
    )
    await settle()
    session.onInterrupt = interrupted(session)

    await glade.invoke(CommandName.TasksStop, { id: task.id })
    await called
    await settle()

    expect(requests().map(({ state }) => state)).toEqual([
      PermissionRequestState.Withdrawn,
      PermissionRequestState.Withdrawn,
    ])
    await expect(outcome).resolves.toEqual({ kind: AccessOutcomeKind.Withdrawn })
    expect(accessReply({ kind: AccessOutcomeKind.Withdrawn }, { path: WEB })).toEqual({
      text: ACCESS_WITHDRAWN,
      isError: true,
    })
    expect(toolCall('toolu_access').state).toBe(ToolCallState.Error)
    expect(taskGrants()).toEqual([])
    // With no session left to ask in, a call ends the same way.
    runner.close()
    await expect(
      runner.requestAccess(task.id, { path: WEB, access: FileAccess.Read, reason: 'Config.' }, { toolUseId: null }),
    ).resolves.toEqual({ kind: AccessOutcomeKind.Withdrawn })
  })

  it('a call the SDK cancels is withdrawn', async () => {
    const session = await startTurn()
    const cancel = new AbortController()
    const called = requestAccess(session, 'toolu_access', writing(CACHE), {}, cancel.signal)
    await settle()

    cancel.abort()

    await expect(called).rejects.toThrow()
    await settle()
    expect(only('toolu_access').state).toBe(PermissionRequestState.Withdrawn)
  })

  it('returns that no decision was made when its session won’t take the grant', async () => {
    const session = await startTurn()
    const called = requestAccess(session, 'toolu_access', writing(CACHE))
    await settle()
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings rejected'))

    await answer('toolu_access', FOR_TASK)
    await called.catch(() => undefined)
    await settle()

    expect(current().error?.details).toContain(SANDBOX_NOT_APPLIED)
  })

  it('a relaunch while its card is open: the card survives, and answering it grants the folder and tells the agent', async () => {
    const session = await startTurn()
    void requestAccess(session, 'toolu_access', writing(CACHE)).catch(() => undefined)
    await settle()

    relaunch()

    expect(only('toolu_access')).toMatchObject({ state: PermissionRequestState.Open, toolName: REQUEST_ACCESS_TOOL })
    expect(current()).toMatchObject({ awaitingPermission: true, activity: TaskActivity.Waiting })
    expect(toolCall('toolu_access').state).toBe(ToolCallState.Interrupted)

    await answer('toolu_access', FOR_TASK)

    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: CACHE, access: FolderAccess.ReadWrite }])
    const resumed = backend.session
    expect(overlay(resumed)).toMatchObject({ allowWrite: [ROOT, CACHE], additionalDirectories: [CACHE] })
    expect(resumed.sent[0]?.text).toContain(
      `- Your request to write to ${CACHE} (${REQUEST_ACCESS_TOOL} call toolu_access): allowed for this task, and in ` +
        'force now. Run what needed it again.',
    )
    // Asked again, as the message's last line invites, it answers at once.
    resumed.emit(sdk.init(`session-${task.id}`))
    await settle()
    await requestAccess(resumed, 'toolu_again', writing(CACHE))
    await settle()
    expect(toolCall('toolu_again').output).toContain('is already granted for this task')
  })
})

describe('what a rule decided', () => {
  const SHARED = `${HOME}/code/acme-shared`
  const TOOLS = `${HOME}/code/tools`

  function marks(taskId = task.id): [string, PermissionMarkOutcome][] {
    return listPermissionMarks(database.db, taskId).map(({ toolUseId, outcome }) => [toolUseId, outcome])
  }

  /** A tool call that Claude Code runs without asking: its `tool_use` alone. */
  async function runs(session: FakeAgentSession, toolUseId: string, name: string, input: Record<string, unknown>) {
    session.emit(sdk.toolUse(toolUseId, name, input))
    await settle()
  }

  /** A sandboxed command that has run: its `tool_use`, then the hook that hears its result. */
  async function command(session: FakeAgentSession, toolUseId: string, output: string, failed = true, input = {}) {
    session.emit(sdk.toolUse(toolUseId, 'Bash', { command: 'uv sync --frozen', ...input }))
    await settle()
    await session.finishBash({ toolUseId, command: 'uv sync --frozen', output, failed }).answer
    session.emit(sdk.toolResult(toolUseId, output, failed))
    await settle()
  }

  const folder = (path: string, access: FolderAccess) => ({ kind: SandboxAskKind.Folder, path, access }) as const
  const grant = (target: SandboxGrantTarget, granted: Grant) =>
    grantSandboxAccess(grantsContext(), { target, grant: granted })

  it('marks a file tool or WebFetch that a grant lets through, by the narrowest scope that grants it', async () => {
    await grant(
      { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id },
      {
        kind: SandboxGrantKind.Folder,
        path: SHARED,
        access: FolderAccess.Read,
      },
    )
    await grant(
      { scope: SandboxGrantScope.Glade },
      { kind: SandboxGrantKind.Folder, path: TOOLS, access: FolderAccess.ReadWrite },
    )
    await grant({ scope: SandboxGrantScope.Glade }, { kind: SandboxGrantKind.Domain, domain: '*.acme.dev' })
    await grant(
      { scope: SandboxGrantScope.Task, taskId: task.id },
      { kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read },
    )
    const session = await startTurn()
    const seen: PermissionMark[] = []
    glade.subscribe((event) => {
      if (event.type === EventType.PermissionMarked) seen.push(event.mark)
    })

    await runs(session, 'toolu_shared', 'Read', { file_path: `${SHARED}/openapi/common.yaml` })
    await runs(session, 'toolu_tools', 'Write', { file_path: `${TOOLS}/bin/gen`, content: 'x' })
    await runs(session, 'toolu_web', 'Read', { file_path: `${WEB}/package.json` })
    await runs(session, 'toolu_fetch', 'WebFetch', { url: 'https://docs.acme.dev/x' })

    expect(marks()).toEqual([
      [
        'toolu_shared',
        { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: folder(SHARED, FolderAccess.Read) },
      ],
      [
        'toolu_tools',
        { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Glade, ask: folder(TOOLS, FolderAccess.ReadWrite) },
      ],
      [
        'toolu_web',
        { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Task, ask: folder(WEB, FolderAccess.Read) },
      ],
      [
        'toolu_fetch',
        {
          kind: PermissionMarkKind.Grant,
          scope: SandboxGrantScope.Glade,
          ask: { kind: SandboxAskKind.Domain, domain: 'docs.acme.dev', command: null, commandDescription: null },
        },
      ],
    ])
    // Each call's mark went to the windows by itself, once.
    expect(seen.map(({ toolUseId }) => toolUseId)).toEqual(['toolu_shared', 'toolu_tools', 'toolu_web', 'toolu_fetch'])
    // And comes back with the task's history.
    const history = await glade.invoke(CommandName.TasksHistory, { id: task.id })
    expect(history.permissionMarks.map(({ toolUseId }) => toolUseId)).toEqual(seen.map(({ toolUseId }) => toolUseId))
  })

  it('marks nothing for a call in the workspace root, outside every folder the sandbox denies, or that will ask', async () => {
    const session = await startTurn()

    await runs(session, 'toolu_mine', 'Edit', { file_path: `${ROOT}/src/date.ts`, old_string: 'a', new_string: 'b' })
    await runs(session, 'toolu_hosts', 'Read', { file_path: '/etc/hosts' })
    await runs(session, 'toolu_outside', 'Read', { file_path: `${WEB}/package.json` })
    await runs(session, 'toolu_search', 'WebSearch', { query: 'backoff' })
    await runs(session, 'toolu_fetch', 'WebFetch', { url: 'https://docs.acme.dev/x' })
    await runs(session, 'toolu_nourl', 'WebFetch', {})
    await runs(session, 'toolu_bash', 'Bash', { command: 'npm test' })

    expect(marks()).toEqual([])
  })

  it('marks a credential path the sandbox refuses, whatever is granted', async () => {
    await grant(
      { scope: SandboxGrantScope.Task, taskId: task.id },
      { kind: SandboxGrantKind.Folder, path: HOME, access: FolderAccess.ReadWrite },
    )
    const session = await startTurn()

    const asked = await callTool(session, {
      toolUseId: 'toolu_key',
      toolName: 'Read',
      input: { file_path: '~/.ssh/id_ed25519' },
    })

    await expect(asked.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: false })
    expect(marks()).toEqual([
      ['toolu_key', { kind: PermissionMarkKind.Blocked, ask: folder(`${HOME}/.ssh/id_ed25519`, FolderAccess.Read) }],
    ])
  })

  it('marks a call a task rule covers in the ask mode, and none in Allow all', async () => {
    const lint = { toolName: 'Bash', ruleContent: 'npm run lint *' }
    addTaskPermissionRule(database.db, { taskId: task.id, rule: lint })
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Edit' } })
    const session = await startTurn()
    await runs(session, 'toolu_allow_all', 'Bash', { command: 'npm run lint' })
    expect(marks()).toEqual([])

    await setMode(PermissionMode.AskBeforeEdits)
    await runs(session, 'toolu_lint', 'Bash', { command: 'npm run lint -- --fix' })
    await runs(session, 'toolu_edit', 'Edit', { file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' })
    await runs(session, 'toolu_test', 'Bash', { command: 'npm test' })
    await runs(session, 'toolu_both', 'Bash', { command: 'npm run lint && rm -rf dist' })

    expect(marks()).toEqual([
      ['toolu_lint', { kind: PermissionMarkKind.TaskRule, rule: lint }],
      ['toolu_edit', { kind: PermissionMarkKind.TaskRule, rule: { toolName: 'Edit' } }],
    ])
  })

  it('marks a task rule’s call with the sandbox off, too', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    await setMode(PermissionMode.AskBeforeEdits)
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Bash', ruleContent: 'npm test' } })
    const session = await startTurn()

    await runs(session, 'toolu_test', 'Bash', { command: 'npm test' })
    await runs(session, 'toolu_read', 'Read', { file_path: `${WEB}/package.json` })

    expect(marks().map(([toolUseId]) => toolUseId)).toEqual(['toolu_test'])
  })

  it('marks a sandboxed command that failed saying the sandbox blocked it, in any case, and no other', async () => {
    const session = await startTurn()

    await command(session, 'toolu_cat', 'Exit code 1\ncat: /x/secret.txt: Operation not permitted')
    await command(session, 'toolu_redirect', 'Exit code 1\n(eval):1: operation not permitted: /x/new.txt')
    // A command that printed the words and went on wasn't stopped by the sandbox: `cat docs/sdk-notes.md`, say, whose
    // text says them. Before #510's review, it read "Blocked by the sandbox".
    await command(session, 'toolu_notes', 'A blocked `cat` fails with "Operation not permitted".', false)
    await command(session, 'toolu_carried_on', 'cat: /x/a: Operation not permitted\ndone', false)
    await command(session, 'toolu_other', 'Exit code 1\nnpm error missing script: build')
    await command(session, 'toolu_fine', 'ok', false)
    // A command you let run outside the sandbox wasn't blocked by it, whatever it prints.
    await command(session, 'toolu_out', 'kill: (1): Operation not permitted', true, { dangerouslyDisableSandbox: true })

    const blocked = { kind: PermissionMarkKind.Blocked, ask: null }
    expect(marks()).toEqual([
      ['toolu_cat', blocked],
      ['toolu_redirect', blocked],
    ])
  })

  it('doesn’t put a request_access path on a command that only printed the words', async () => {
    const session = await startTurn()
    await command(session, 'toolu_notes', 'A blocked `cat` fails with "Operation not permitted".', false)

    void asksAccess(session, 'toolu_access', `${HOME}/code/cache`, 'write')
    await settle()

    expect(marks()).toEqual([])
    expect(only('toolu_access').state).toBe(PermissionRequestState.Open)
  })

  it('names a blocked command only from the same agent’s very next call', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Client generator', prompt: 'Go.' }))
    await settle()
    const subagent = { agentId: 'agent-7', parent: 'toolu_agent' }
    const blocked = { kind: PermissionMarkKind.Blocked, ask: null }
    const cache = `${HOME}/code/cache`

    // The agent's own command is blocked, then its subagent asks for something of its own: not the same agent's.
    await command(session, 'toolu_main', 'Exit code 1\ncat: /x: Operation not permitted')
    void asksAccess(session, 'toolu_sub_access', WEB, 'read', subagent)
    await settle()
    expect(marks()).toEqual([['toolu_main', blocked]])

    // The subagent's command is blocked, and the agent asks: not the subagent's either.
    session.emit(sdk.toolUse('toolu_sub_uv', 'Bash', { command: 'uv sync' }, 'toolu_agent'))
    await settle()
    const output = 'Exit code 1\nerror: Operation not permitted (os error 1)'
    await session.finishBash({ toolUseId: 'toolu_sub_uv', command: 'uv sync', output, failed: true }).answer
    session.emit(sdk.toolResult('toolu_sub_uv', output, true))
    await settle()
    // Another call of the agent's came between its blocked command and its request: that isn't "just before" either.
    await runs(session, 'toolu_between', 'Read', { file_path: `${ROOT}/a.ts` })
    void asksAccess(session, 'toolu_main_access', `${HOME}/code/elsewhere`, 'write')
    await settle()
    expect(marks()).toEqual([
      ['toolu_main', blocked],
      ['toolu_sub_uv', blocked],
    ])

    // The subagent's next call asks for what its own command was blocked from: that names it.
    void asksAccess(session, 'toolu_sub_access_2', cache, 'write', subagent)
    await settle()
    expect(marks()).toEqual([
      ['toolu_main', blocked],
      ['toolu_sub_uv', { kind: PermissionMarkKind.Blocked, ask: folder(cache, FolderAccess.ReadWrite) }],
    ])
  })

  it('never marks a call allowed that crosses the sandbox’s bounds: it’s asked about or refused, whatever rule covers it', async () => {
    await setMode(PermissionMode.AskBeforeEdits)
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Bash', ruleContent: 'docker compose *' } })
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Read' } })
    const session = await startTurn()
    // The sandbox couldn't start: from here on, every request to run outside it is refused without a card.
    session.emit(sdk.toolUse('toolu_ls', 'Bash', { command: 'ls' }))
    await settle()
    const failure = sandboxInitFailure('sandbox-exec: command not found')
    await session.finishBash({ toolUseId: 'toolu_ls', command: 'ls', output: failure, failed: true }).answer

    // Before #510's review, this row read "Allowed by task rule", though the command was refused.
    const refused = await callTool(session, sandboxOverrideCall('toolu_out', OVERRIDE, true))
    await expect(refused.answer).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: SANDBOX_FAILED_REFUSAL,
      byUser: false,
    })
    // And a read outside the bounds asks, whole-tool rule or not.
    await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    expect(only('toolu_read').state).toBe(PermissionRequestState.Open)
    expect(marks()).toEqual([])

    // A call inside the bounds that a rule covers is still marked.
    await runs(session, 'toolu_ps', 'Bash', { command: 'docker compose ps' })
    await runs(session, 'toolu_mine', 'Read', { file_path: `${ROOT}/a.ts` })
    expect(marks().map(([toolUseId, { kind }]) => [toolUseId, kind])).toEqual([
      ['toolu_ps', PermissionMarkKind.TaskRule],
      ['toolu_mine', PermissionMarkKind.TaskRule],
    ])
  })

  it('reads the task’s rules and grants again once they change, and not before', async () => {
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()
    const workspaceTarget = { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id } as const

    // No rule and no grant yet: neither call is marked.
    const edit = { file_path: `${ROOT}/src/date.ts`, old_string: 'a', new_string: 'b' }
    await runs(session, 'toolu_shared_0', 'Read', { file_path: `${SHARED}/a.md` })
    const asked = await callTool(session, { toolUseId: 'toolu_edit', toolName: 'Edit', input: edit })
    expect(marks()).toEqual([])

    // Allow for this task on the card grants the rule: the next call it covers says so.
    await answer('toolu_edit', FOR_TASK)
    await expect(asked.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Allow })
    await runs(session, 'toolu_edit_1', 'Edit', edit)
    // And a grant made in Settings while the session runs marks the next call it lets through.
    await grant(workspaceTarget, { kind: SandboxGrantKind.Folder, path: SHARED, access: FolderAccess.Read })
    await runs(session, 'toolu_shared_1', 'Read', { file_path: `${SHARED}/a.md` })
    await revokeSandboxGrant(grantsContext(), workspaceTarget, { kind: SandboxGrantKind.Folder, path: SHARED })
    await runs(session, 'toolu_shared_2', 'Read', { file_path: `${SHARED}/a.md` })

    expect(marks().map(([toolUseId, { kind }]) => [toolUseId, kind])).toEqual([
      ['toolu_edit_1', PermissionMarkKind.TaskRule],
      ['toolu_shared_1', PermissionMarkKind.Grant],
    ])
  })

  it('names what the blocked command was blocked from once the agent’s request_access says, on the one just before', async () => {
    const session = await startTurn()
    await command(session, 'toolu_first', 'Exit code 1\ncat: /x: Operation not permitted')
    await command(session, 'toolu_uv', 'Exit code 1\nerror: Operation not permitted (os error 1)')

    void session
      .callTool('toolu_access', REQUEST_ACCESS_TOOL, {
        path: `${HOME}/code/cache`,
        access: 'write',
        reason: 'uv needs its cache.',
      })
      .catch(() => undefined)
    await settle()

    expect(marks()).toEqual([
      ['toolu_first', { kind: PermissionMarkKind.Blocked, ask: null }],
      ['toolu_uv', { kind: PermissionMarkKind.Blocked, ask: folder(`${HOME}/code/cache`, FolderAccess.ReadWrite) }],
    ])
    // The request itself is a card's: its row shows your answer, not a mark.
    expect(only('toolu_access').state).toBe(PermissionRequestState.Open)
  })

  it('marks a request_access answered without a card: by the grant that covers it, or refused for a credential path', async () => {
    await grant(
      { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id },
      {
        kind: SandboxGrantKind.Folder,
        path: SHARED,
        access: FolderAccess.Read,
      },
    )
    const session = await startTurn()
    await command(session, 'toolu_cat', 'Exit code 1\ncat: Operation not permitted')
    const access = (toolUseId: string, path: string, kind = 'read') =>
      session.callTool(toolUseId, REQUEST_ACCESS_TOOL, { path, access: kind, reason: 'Needed.' })

    await access('toolu_granted', `${SHARED}/notes.md`)
    await access('toolu_key', '~/.ssh/id_ed25519')
    await access('toolu_root', `${ROOT}/out.txt`, 'write')
    await access('toolu_etc', '/etc/hosts')
    await access('toolu_glob', `${HOME}/code/*`)
    await settle()

    expect(marks()).toEqual([
      // The blocked command is named by the first request after it, as the path that request named.
      ['toolu_cat', { kind: PermissionMarkKind.Blocked, ask: folder(`${SHARED}/notes.md`, FolderAccess.Read) }],
      [
        'toolu_granted',
        { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: folder(SHARED, FolderAccess.Read) },
      ],
      ['toolu_key', { kind: PermissionMarkKind.Blocked, ask: folder(`${HOME}/.ssh/id_ed25519`, FolderAccess.Read) }],
    ])
  })

  it('keeps its marks across a relaunch', async () => {
    const session = await startTurn()
    await command(session, 'toolu_cat', 'Exit code 1\ncat: Operation not permitted')

    relaunch()

    const history = await glade.invoke(CommandName.TasksHistory, { id: task.id })
    expect(history.permissionMarks).toMatchObject([
      { toolUseId: 'toolu_cat', outcome: { kind: PermissionMarkKind.Blocked, ask: null } },
    ])
  })
})

describe('a card grants exactly what it showed', () => {
  const SCRATCH = `${HOME}/scratch`
  const CACHE = `${SCRATCH}/cache`
  const DOCUMENTS = `${HOME}/Documents`

  beforeEach(() => {
    mkdirSync(CACHE, { recursive: true })
    mkdirSync(DOCUMENTS, { recursive: true })
    writeFileSync(`${DOCUMENTS}/taxes.txt`, 'private')
  })

  afterEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
    rmSync(DOCUMENTS, { recursive: true, force: true })
  })

  it.each([FOR_TASK, FOR_WORKSPACE])(
    'request_access: a folder swapped for a link while its card is open is not granted, and the agent is told why (%o)',
    async (allow) => {
      const session = await startTurn()
      const called = asksAccess(session, 'toolu_access', CACHE, 'write')
      await settle()
      expect(only('toolu_access').sandbox).toMatchObject({ path: CACHE, access: FolderAccess.ReadWrite })
      const overlays = session.flagSettings.length

      // Before #510's review, allowing it now granted Documents, read-write: where the link leads.
      swapForLink(CACHE, DOCUMENTS)
      await answer('toolu_access', allow)
      await called
      await settle()

      expect(only('toolu_access')).toMatchObject({
        state: PermissionRequestState.Denied,
        denyNote: FOLDER_MOVED_NOTE,
        grantedScope: null,
      })
      expect(taskGrants()).toEqual([])
      expect(workspaceGrants()).toEqual([])
      expect(session.flagSettings).toHaveLength(overlays)
      expect(toolCall('toolu_access').state).toBe(ToolCallState.Error)
      expect(toolCall('toolu_access').output).toContain(FOLDER_MOVED_NOTE)
      expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    },
  )

  it('a file tool’s card: a folder swapped while it’s open is not granted, and the call doesn’t run', async () => {
    const session = await startTurn()
    const asked = await callTool(session, writeOf('toolu_write', `${CACHE}/index.json`))
    expect(only('toolu_write').sandbox).toMatchObject({ path: CACHE, access: FolderAccess.ReadWrite })

    swapForLink(CACHE, DOCUMENTS)
    await answer('toolu_write', FOR_WORKSPACE)

    await expect(asked.answer).resolves.toMatchObject({
      behavior: ToolPermissionBehavior.Deny,
      message: expect.stringContaining(FOLDER_MOVED_NOTE) as unknown,
    })
    expect(only('toolu_write')).toMatchObject({ state: PermissionRequestState.Denied, denyNote: FOLDER_MOVED_NOTE })
    expect(taskGrants()).toEqual([])
    expect(workspaceGrants()).toEqual([])
    expect(overlay(session).allowWrite).toEqual([ROOT])
  })

  it('a granted folder swapped for a link afterwards opens nothing new: a file tool asks again, and the overlay still names the path granted', async () => {
    const session = await startTurn()
    const first = await callTool(session, writeOf('toolu_first', `${CACHE}/index.json`))
    await answer('toolu_first', FOR_TASK)
    await expect(first.answer).resolves.toEqual(ALLOWED_BY_YOU)
    const granted: Grant = { kind: SandboxGrantKind.Folder, path: CACHE, access: FolderAccess.ReadWrite }
    expect(taskGrants()).toEqual([granted])
    const inside = await callTool(session, {
      toolUseId: 'toolu_inside',
      toolName: 'Read',
      input: { file_path: `${CACHE}/index.json` },
    })
    await expect(inside.answer).resolves.toEqual(ALLOWED_AT_ONCE)

    swapForLink(CACHE, DOCUMENTS)
    // Any change to the task's grants builds its bounds again: before #510's review, they then followed the link, and
    // Documents opened to the file tools.
    await grantSandboxAccess(grantsContext(), {
      target: { scope: SandboxGrantScope.Glade },
      grant: { kind: SandboxGrantKind.Domain, domain: 'docs.acme.dev' },
    })

    const through = await callTool(session, {
      toolUseId: 'toolu_through',
      toolName: 'Read',
      input: { file_path: `${CACHE}/taxes.txt` },
    })
    expect(await isSettled(through.answer)).toBe(false)
    // The card names where the call really leads, not the folder that was granted.
    expect(only('toolu_through').sandbox).toEqual({
      kind: SandboxAskKind.Folder,
      path: DOCUMENTS,
      access: FolderAccess.Read,
    })
    await callTool(session, writeOf('toolu_direct', `${DOCUMENTS}/taxes.txt`))
    expect(only('toolu_direct').state).toBe(PermissionRequestState.Open)
    // The grant, and what the session is told of it, is still the path that was granted.
    expect(taskGrants()).toEqual([granted])
    expect(overlay(session)).toMatchObject({
      allowRead: [ROOT, CACHE],
      allowWrite: [ROOT, CACHE],
      additionalDirectories: [CACHE],
    })
    // And no call through the link is marked as let through by the grant.
    expect(listPermissionMarks(database.db, task.id).map(({ toolUseId }) => toolUseId)).toEqual(['toolu_inside'])
  })
})

describe('a file whose folder is too much to offer', () => {
  const GITCONFIG = `${HOME}/.gitconfig`
  const ZSHRC = `${HOME}/.zshrc`
  const NOTES = `${HOME}/notes.txt`

  beforeEach(() => {
    writeFileSync(GITCONFIG, '[user]\n')
    writeFileSync(ZSHRC, '')
  })

  afterEach(() => {
    for (const file of [GITCONFIG, ZSHRC, NOTES]) rmSync(file, { force: true })
  })

  const reads = (toolUseId: string, path: string): PermissionCallFields => ({
    toolUseId,
    toolName: 'Read',
    input: { file_path: path },
  })

  it('request_access for a file in the home folder asks for that file, and grants it alone', async () => {
    const session = await startTurn()

    // Before #510's review, this card asked for the whole home folder.
    const called = asksAccess(session, 'toolu_access', '~/.gitconfig')
    await settle()
    const file = { kind: SandboxAskKind.Folder, path: GITCONFIG, access: FolderAccess.Read, file: true } as const
    expect(only('toolu_access').sandbox).toEqual(file)
    await answer('toolu_access', FOR_TASK)
    await called
    await settle()

    expect(taskGrants()).toEqual([
      { kind: SandboxGrantKind.Folder, path: GITCONFIG, access: FolderAccess.Read, file: true },
    ])
    expect(toolCall('toolu_access').output).toBe(
      `Allowed for this task: you can now read ${GITCONFIG}. Run the command that was blocked again.`,
    )
    // Commands may read that file; the file tools get a rule for exactly it, with no `/**` and no directory.
    expect(overlay(session)).toEqual({
      allowRead: [ROOT, GITCONFIG],
      allowWrite: [ROOT],
      allow: [`Read(/${GITCONFIG})`],
      additionalDirectories: [],
    })

    // Glade's own check agrees: the file reads, and nothing beside it does.
    const granted = await callTool(session, reads('toolu_granted', GITCONFIG))
    await expect(granted.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(listPermissionMarks(database.db, task.id).map(({ toolUseId, outcome }) => [toolUseId, outcome])).toEqual([
      ['toolu_granted', { kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Task, ask: file }],
    ])
    const beside = await callTool(session, reads('toolu_beside', ZSHRC))
    expect(await isSettled(beside.answer)).toBe(false)
    expect(only('toolu_beside').sandbox).toEqual({ ...file, path: ZSHRC })
    for (const [index, path] of [`${GITCONFIG}.bak`, `${GITCONFIG}/x`, `${HOME}/.gitconfig-work`].entries()) {
      const toolUseId = `toolu_near_${String(index)}`
      await callTool(session, reads(toolUseId, path))
      expect(only(toolUseId).state).toBe(PermissionRequestState.Open)
    }
    // It was granted to read: a write to it asks, for the file again.
    await callTool(session, writeOf('toolu_write', GITCONFIG))
    expect(only('toolu_write').sandbox).toEqual({ ...file, access: FolderAccess.ReadWrite })
    // Asked for again, there's nothing to decide.
    await asksAccess(session, 'toolu_again', GITCONFIG)
    expect(toolCall('toolu_again').output).toBe(
      `${GITCONFIG} is already granted for this task with that access: nothing more to grant.`,
    )
  })

  it('a file tool’s write to a file in the home folder asks for that file, and grants it read-write alone', async () => {
    const session = await startTurn()

    // Claude Code suggests the file's folder, the home folder itself: the card asks for the file instead.
    const asked = await callTool(session, writeOf('toolu_write', NOTES))
    const file = { kind: SandboxAskKind.Folder, path: NOTES, access: FolderAccess.ReadWrite, file: true } as const
    expect(only('toolu_write').sandbox).toEqual(file)
    await answer('toolu_write', FOR_WORKSPACE)
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)

    expect(workspaceGrants()).toEqual([
      { kind: SandboxGrantKind.Folder, path: NOTES, access: FolderAccess.ReadWrite, file: true },
    ])
    // Commands may read and write that file; the file tools get `Read` and `Edit` rules for exactly it. It's never an
    // additional directory, which Claude Code takes for a folder and all in it.
    expect(overlay(session)).toEqual({
      allowRead: [ROOT, NOTES],
      allowWrite: [ROOT, NOTES],
      allow: [`Read(/${NOTES})`, `Edit(/${NOTES})`],
      additionalDirectories: [],
    })
    // What's beside it still asks, each for itself.
    for (const [index, path] of [`${HOME}/notes-2.txt`, `${NOTES}.bak`, `${NOTES}/x`].entries()) {
      const toolUseId = `toolu_near_${String(index)}`
      await callTool(session, writeOf(toolUseId, path))
      expect(only(toolUseId).state).toBe(PermissionRequestState.Open)
      expect(only(toolUseId).sandbox).not.toBeNull()
    }
    // A read of it goes ahead. A write Claude Code still asks about gets the plain card, in Allow all, as any write
    // inside the bounds that reaches Glade does: allowed once or denied, never more.
    const read = await callTool(session, reads('toolu_read', NOTES))
    await expect(read.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    await callTool(session, writeOf('toolu_write_2', NOTES))
    expect(only('toolu_write_2')).toMatchObject({ sandbox: null, state: PermissionRequestState.Open })
  })

  it('request_access refuses a folder that’s too much, with no card, and says where to add it', async () => {
    const session = await startTurn()

    const folders = ['~', HOME, '/Users', '/Volumes', '/System/Volumes']
    for (const [index, path] of folders.entries()) {
      const toolUseId = `toolu_broad_${String(index)}`
      await asksAccess(session, toolUseId, path, 'write')
      expect(toolCall(toolUseId).state).toBe(ToolCallState.Error)
      expect(toolCall(toolUseId).output).toContain(`Refused: ${path} is too much to grant from a request`)
      expect(toolCall(toolUseId).output).toContain('they can add it under Sandbox in Settings')
    }
    // A credential file in the home folder is refused as it always was, not asked for by itself.
    await asksAccess(session, 'toolu_netrc', '~/.netrc')
    expect(toolCall('toolu_netrc').output).toContain('is one of the credential files')

    expect(requests()).toEqual([])
    expect(taskGrants()).toEqual([])
    expect(current().awaitingPermission).toBe(false)
  })

  it('a file tool that names such a folder gets the plain card: allowed once or denied, never granted', async () => {
    const session = await startTurn()

    const listed = await callTool(session, { toolUseId: 'toolu_ls', toolName: 'LS', input: { path: '~' } })
    await callTool(session, { toolUseId: 'toolu_users', toolName: 'LS', input: { path: '/Users' } })

    for (const toolUseId of ['toolu_ls', 'toolu_users']) {
      expect(only(toolUseId)).toMatchObject({ sandbox: null, suppressAlwaysAllowRule: true })
    }
    for (const remembered of [FOR_TASK, FOR_WORKSPACE]) {
      await expect(answer('toolu_ls', remembered)).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    }
    await answer('toolu_ls', ONCE)
    await expect(listed.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(taskGrants()).toEqual([])
    expect(workspaceGrants()).toEqual([])
  })

  it('a link to a file asks for the real file’s folder, never the link’s', async () => {
    writeFileSync(`${WEB}/config.json`, '{}')
    symlinkSync(`${WEB}/config.json`, `${ROOT}/linked.json`)
    symlinkSync(GITCONFIG, `${ROOT}/gitconfig`)
    const session = await startTurn()

    // Before #510's review, each of these cards asked for the workspace root itself.
    void asksAccess(session, 'toolu_link', `${ROOT}/linked.json`)
    void asksAccess(session, 'toolu_home_link', `${ROOT}/gitconfig`, 'write')
    await callTool(session, reads('toolu_read', `${ROOT}/linked.json`))

    const web = { kind: SandboxAskKind.Folder, path: WEB, access: FolderAccess.Read }
    expect(only('toolu_link').sandbox).toEqual(web)
    expect(only('toolu_read').sandbox).toEqual(web)
    expect(only('toolu_home_link').sandbox).toEqual({
      kind: SandboxAskKind.Folder,
      path: GITCONFIG,
      access: FolderAccess.ReadWrite,
      file: true,
    })
    rmSync(`${ROOT}/linked.json`, { force: true })
    rmSync(`${ROOT}/gitconfig`, { force: true })
  })
})

describe('a denial lasts the turn', () => {
  const NOTE = 'Use the vendored copy.'
  const deny = (note?: string): PermissionDecision => ({ kind: PermissionDecisionKind.Deny, ...(note ? { note } : {}) })
  const asked = (): string[] => requests().map(({ toolUseId }) => toolUseId)

  it('request_access again for a folder you denied is answered denied at once, with your note and no card', async () => {
    const session = await startTurn()
    const first = asksAccess(session, 'toolu_1', WEB)
    await settle()
    await answer('toolu_1', deny(NOTE))
    await first
    notifyReply.mockClear()

    // Before #510's review, each of these opened a card again, as often as the agent asked.
    await asksAccess(session, 'toolu_2', WEB)
    await asksAccess(session, 'toolu_3', '~/code/acme-web/')
    // A write reads too: the read you denied denies it.
    await asksAccess(session, 'toolu_4', WEB, 'write')
    await settle()

    expect(asked()).toEqual(['toolu_1'])
    for (const toolUseId of ['toolu_2', 'toolu_3', 'toolu_4']) {
      expect(toolCall(toolUseId).state).toBe(ToolCallState.Error)
      expect(toolCall(toolUseId).output).toContain('the user already denied')
      expect(toolCall(toolUseId).output).toContain(`The user said: ${NOTE}`)
    }
    expect(taskGrants()).toEqual([])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    expect(notifyReply).not.toHaveBeenCalled()
    // Another folder still asks.
    void asksAccess(session, 'toolu_5', `${HOME}/code/other`)
    await settle()
    expect(only('toolu_5').state).toBe(PermissionRequestState.Open)
  })

  it('asks again once you’ve sent the next message', async () => {
    const session = await startTurn()
    const first = asksAccess(session, 'toolu_1', WEB)
    await settle()
    await answer('toolu_1', deny())
    await first
    await asksAccess(session, 'toolu_2', WEB)
    expect(asked()).toEqual(['toolu_1'])
    session.emit(sdk.result('I couldn’t read it.'))
    await settle()

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Go on, ask me again.' })
    await settle()
    void asksAccess(session, 'toolu_3', WEB)
    await settle()

    expect(only('toolu_3').state).toBe(PermissionRequestState.Open)
    expect(only('toolu_3').turn).toBe(only('toolu_1').turn + 1)
  })

  it('a subagent repeating the agent’s denied request is denied the same, and the agent a subagent’s', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Client generator', prompt: 'Go.' }))
    await settle()
    const subagent = { agentId: 'agent-7', parent: 'toolu_agent' }
    const first = asksAccess(session, 'toolu_main', WEB)
    const other = asksAccess(session, 'toolu_sub', `${HOME}/code/cache`, 'write', subagent)
    await settle()
    await answer('toolu_main', deny(NOTE))
    await answer('toolu_sub', deny())
    await Promise.all([first, other])

    await asksAccess(session, 'toolu_sub_again', WEB, 'read', subagent)
    await asksAccess(session, 'toolu_main_again', `${HOME}/code/cache`, 'write')
    await settle()

    expect(asked()).toEqual(['toolu_main', 'toolu_sub'])
    expect(toolCall('toolu_sub_again').output).toContain(`The user said: ${NOTE}`)
    expect(toolCall('toolu_main_again').output).toContain('the user already denied')
    expect(toolCall('toolu_main_again').output).not.toContain('The user said')
  })

  it('a file tool’s crossing, WebFetch and a command’s connection you denied are denied again without asking', async () => {
    const session = await startTurn()
    await callTool(session, readOf('toolu_read', `${WEB}/package.json`))
    await answer('toolu_read', deny(NOTE))
    await startCommand(session, 'toolu_install', { command: 'npm install' })
    session.requestPermission(networkAccessCall(HOST, 'net-1'))
    await settle()
    await answer('toolu_install', deny())

    const again = await callTool(session, readOf('toolu_read_2', `${WEB}/README.md`))
    const written = await callTool(session, writeOf('toolu_write', `${WEB}/README.md`))
    await asksAccess(session, 'toolu_access', WEB)
    const connected = session.requestPermission(networkAccessCall(HOST, 'net-2'))
    const fetched = await callTool(session, webFetchCall('toolu_fetch', { url: `https://${HOST}/x`, prompt: 'Read.' }))

    const denied = (note: string | null): ToolPermissionAnswer => ({
      behavior: ToolPermissionBehavior.Deny,
      message: alreadyDeniedMessage(note),
      byUser: false,
    })
    await expect(again.answer).resolves.toEqual(denied(NOTE))
    await expect(written.answer).resolves.toEqual(denied(NOTE))
    await expect(connected.answer).resolves.toEqual(denied(null))
    await expect(fetched.answer).resolves.toEqual(denied(null))
    expect(alreadyDeniedMessage(NOTE)).toContain(`They said: ${NOTE}`)
    expect(toolCall('toolu_access').output).toContain('the user already denied')
    expect(asked()).toEqual(['toolu_read', 'toolu_install'])
    expect(current().awaitingPermission).toBe(false)
  })

  it('a write you denied still lets a read ask, and cards open at the same time each keep theirs', async () => {
    const session = await startTurn()
    const write = await callTool(session, writeOf('toolu_write', `${WEB}/a.ts`))
    // Two more for the same folder, open before the first is answered.
    const second = await callTool(session, writeOf('toolu_write_2', `${WEB}/b.ts`))
    const third = asksAccess(session, 'toolu_access', WEB, 'write')
    await settle()

    await answer('toolu_write', deny(NOTE))
    await expect(write.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: true })
    // The others are still yours to answer.
    expect(only('toolu_write_2').state).toBe(PermissionRequestState.Open)
    expect(only('toolu_access').state).toBe(PermissionRequestState.Open)
    await answer('toolu_access', FOR_TASK)
    await third
    await answer('toolu_write_2', FOR_TASK)
    await expect(second.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('a write you denied still lets a read of the folder ask', async () => {
    const session = await startTurn()
    await callTool(session, writeOf('toolu_write', `${WEB}/a.ts`))
    await answer('toolu_write', deny())

    await callTool(session, readOf('toolu_read', `${WEB}/a.ts`))

    expect(only('toolu_read')).toMatchObject({
      state: PermissionRequestState.Open,
      sandbox: { path: WEB, access: FolderAccess.Read },
    })
  })

  it('running outside the sandbox asks every time, denied or not', async () => {
    const session = await startTurn()
    await callTool(session, sandboxOverrideCall('toolu_out', OVERRIDE, true))
    await answer('toolu_out', deny(NOTE))

    await callTool(session, sandboxOverrideCall('toolu_out_2', OVERRIDE, true))

    expect(only('toolu_out_2').state).toBe(PermissionRequestState.Open)
  })
})
