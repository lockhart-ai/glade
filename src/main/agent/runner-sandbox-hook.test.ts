// The phase's security review (#514): Glade decides a sandboxed session's file-tool, `WebFetch`, `Bash` and `Monitor`
// calls in the session's `PreToolUse` hook, before any of Claude Code's rules can let one through. Each test here is
// one of the review's attacks: the call is put to the hook alone, as it would arrive with a rule in the user's, the
// project's or the local Claude Code settings that keeps Claude Code from ever asking about it (`canUseTool`).
// A fake agent session behind the real bridge, in a temporary home folder.
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
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
  type PermissionRequest,
  type Task,
  type ToolCallEvent,
  type ToolInput,
  type Workspace,
} from '../../shared/domain'
import { FolderAccess, SandboxAskKind, SandboxGrantKind, SandboxGrantScope, type Grant } from '../../shared/sandbox'
import { REQUEST_ACCESS_TOOL } from '../../shared/toolName'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listPermissionMarks } from '../db/repositories/permission-marks'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { addSandboxGrant, listSandboxGrants } from '../db/repositories/sandbox-grants'
import { updateSettings } from '../db/repositories/settings'
import { addTaskPermissionRule } from '../db/repositories/task-permission-rules'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { ToolPermissionBehavior, type ToolStartDecision } from './backend'
import { projectSettingsFiles } from './excluded-commands'
import { FakeAgentBackend, settle, type FakeAgentSession } from './fake-backend'
import {
  CREDENTIAL_REFUSAL,
  PERMISSION_WITHDRAWN_NOTE,
  SANDBOX_FAILED_REFUSAL,
  UNRESOLVABLE_REFUSAL,
  type AgentRunner,
} from './runner'
import { protectedWrites } from './sandbox'
import { sandboxInitFailure, sandboxOverrideCall } from './sandbox-requests'
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
/** Where a file written runs at the next login: the review's target. */
const LAUNCH_AGENTS = `${HOME}/Library/LaunchAgents`
const PLIST = `${LAUNCH_AGENTS}/dev.acme.sample.plist`
/** Glade's own data folder, as the app names it. */
const DATA = `${HOME}/Library/Application Support/glade`
/** A folder a command asks for, then swaps. */
const CACHE = `${HOME}/newcache`
const SHARED = `${HOME}/code/acme-shared`

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner

function launch(): void {
  backend = new FakeAgentBackend()
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
    dataDir: DATA,
    // The project's own Claude Code settings, as a test mode reads them: never the machine's.
    claudeSettings: projectSettingsFiles,
  }))
  glade = createBridge(ipc.renderer)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  for (const folder of [ROOT, LAUNCH_AGENTS, DATA, SHARED, `${HOME}/.ssh`]) mkdirSync(folder, { recursive: true })
  writeFileSync(`${HOME}/.ssh/id_rsa`, 'sample key\n')
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
  for (const path of ['Library', 'code', 'newcache', 'newcache.was', '.ssh', 'src', 'Documents']) {
    rmSync(`${HOME}/${path}`, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

const BOTH_MODES = [PermissionMode.AllowAll, PermissionMode.AskBeforeEdits]
const FOR_TASK: PermissionDecision = { kind: PermissionDecisionKind.AllowForTask }
const ONCE: PermissionDecision = { kind: PermissionDecisionKind.AllowOnce }
const DENY: PermissionDecision = { kind: PermissionDecisionKind.Deny }
const ALLOWED_BY_YOU: ToolStartDecision = { behavior: ToolPermissionBehavior.Allow, byUser: true }

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

async function setMode(permissionMode: PermissionMode): Promise<void> {
  await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { permissionMode } })
  await settle()
}

/** Sends a message, and has the task's session start its turn. */
async function startTurn(): Promise<FakeAgentSession> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Publish the client.' })
  const session = backend.session
  session.emit(sdk.init(`session-${task.id}`))
  await settle()
  return session
}

/** A call on its way to running: what the hook decided of it, once it has, and whether it has yet. */
interface Started {
  readonly decision: Promise<ToolStartDecision | null>
  readonly abort: () => void
  readonly settled: () => boolean
}

/**
 * The agent calls a tool, and the session's `PreToolUse` hook hears of it before anything else: the `tool_use`, then
 * the hook. Claude Code is never asked (`canUseTool`): a rule in the user's settings let the call through.
 */
async function starts(
  session: FakeAgentSession,
  toolUseId: string,
  toolName: string,
  input: ToolInput,
  agentId: string | null = null,
): Promise<Started> {
  session.emit(sdk.toolUse(toolUseId, toolName, { ...input }))
  await settle()
  const started = session.startTool({ toolName, toolUseId, input, agentId })
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

function requests(): PermissionRequest[] {
  return listPermissionRequests(database.db, task.id)
}

function only(toolUseId: string): PermissionRequest {
  const found = requests().find((request) => request.toolUseId === toolUseId)
  if (found === undefined) throw new Error(`No request for ${toolUseId}`)
  return found
}

async function answer(toolUseId: string, decision: PermissionDecision): Promise<void> {
  await glade.invoke(CommandName.PermissionsAnswer, { id: only(toolUseId).id, decision })
  await settle()
}

function toolCall(toolUseId: string): ToolCallEvent {
  const found = listToolEvents(database.db, task.id).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No tool call ${toolUseId}`)
  return found
}

function taskGrants(): Grant[] {
  return listSandboxGrants(database.db, { scope: SandboxGrantScope.Task, taskId: task.id }).map(({ grant }) => grant)
}

function grantToTask(grant: Grant): void {
  addSandboxGrant(database.db, { target: { scope: SandboxGrantScope.Task, taskId: task.id }, grant })
}

/** The agent calls `request_access`: resolves once the tool has returned, which a card holds up. */
function asksAccess(
  session: FakeAgentSession,
  toolUseId: string,
  path: string,
  access: 'read' | 'write',
): Promise<void> {
  const input = { path, access, reason: 'uv needs a cache.' }
  const called = session.callTool(toolUseId, REQUEST_ACCESS_TOOL, input)
  called.catch(() => undefined)
  return called
}

describe('a rule in the user’s own Claude Code settings', () => {
  // Finding 3: `permissions.allow: ["Write"]` in `~/.claude/settings.json` or the repository's `.claude/settings.json`,
  // and `Write ~/Library/LaunchAgents/x.plist` ran with no card: #474's finding 3 again, from another source.
  it.each(BOTH_MODES)('can’t let a write outside the bounds run unasked, in %s', async (mode) => {
    await setMode(mode)
    const session = await startTurn()

    const write = await starts(session, 'toolu_plist', 'Write', { file_path: PLIST, content: '<plist/>' })

    // The call waits on a card, though Claude Code was never asked about it.
    expect(write.settled()).toBe(false)
    expect(only('toolu_plist')).toMatchObject({
      state: PermissionRequestState.Open,
      toolName: 'Write',
      suppressAlwaysAllowRule: true,
      sandbox: { kind: SandboxAskKind.Folder, path: LAUNCH_AGENTS, access: FolderAccess.ReadWrite },
    })
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

    await answer('toolu_plist', { kind: PermissionDecisionKind.Deny, note: 'Not there.' })

    await expect(write.decision).resolves.toMatchObject({
      behavior: ToolPermissionBehavior.Deny,
      message: expect.stringContaining('Not there.') as unknown,
      byUser: true,
    })
    expect(taskGrants()).toEqual([])
  })

  it.each(BOTH_MODES)('can’t let a read of your files run unasked, in %s', async (mode) => {
    await setMode(mode)
    mkdirSync(`${HOME}/Documents`, { recursive: true })
    const session = await startTurn()

    const read = await starts(session, 'toolu_taxes', 'Read', { file_path: '~/Documents/taxes.pdf' })

    expect(read.settled()).toBe(false)
    expect(only('toolu_taxes').sandbox).toEqual({
      kind: SandboxAskKind.Folder,
      path: `${HOME}/Documents`,
      access: FolderAccess.Read,
    })
    // Allowed for the task, the grant is saved and live before the call goes on.
    await answer('toolu_taxes', FOR_TASK)
    await expect(read.decision).resolves.toEqual(ALLOWED_BY_YOU)
    expect(taskGrants()).toEqual([
      { kind: SandboxGrantKind.Folder, path: `${HOME}/Documents`, access: FolderAccess.Read },
    ])
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem?.allowRead).toEqual([ROOT, `${HOME}/Documents`])
    // And the next read there is left to Claude Code, which asks, not knowing of the grant: it goes ahead.
    const next = await starts(session, 'toolu_next', 'Read', { file_path: '~/Documents/receipts.pdf' })
    await expect(next.decision).resolves.toBeNull()
    const asked = session.requestPermission({
      toolUseId: 'toolu_next',
      toolName: 'Read',
      input: { file_path: '~/Documents/receipts.pdf' },
    })
    await expect(asked.answer).resolves.toEqual({ behavior: ToolPermissionBehavior.Allow, byUser: false })
    expect(requests()).toHaveLength(1)
  })

  it.each(BOTH_MODES)('can’t open a credential file, in %s: refused in the hook, with no card', async (mode) => {
    await setMode(mode)
    // Even with the whole home folder granted, as a broad `Read(~/**)` rule would have it.
    grantToTask({ kind: SandboxGrantKind.Folder, path: HOME, access: FolderAccess.ReadWrite })
    const session = await startTurn()

    const read = await starts(session, 'toolu_key', 'Read', { file_path: '~/.ssh/id_rsa' })
    const write = await starts(session, 'toolu_npmrc', 'Edit', { file_path: `${HOME}/.npmrc` })
    const state = await starts(session, 'toolu_state', 'Read', { file_path: `${HOME}/.claude.json` })

    for (const call of [read, write, state]) {
      await expect(call.decision).resolves.toEqual({
        behavior: ToolPermissionBehavior.Deny,
        message: CREDENTIAL_REFUSAL,
        byUser: false,
      })
    }
    expect(requests()).toEqual([])
    expect(current().awaitingPermission).toBe(false)
  })

  it.each(BOTH_MODES)('can’t let WebFetch reach a domain nobody granted, in %s', async (mode) => {
    await setMode(mode)
    grantToTask({ kind: SandboxGrantKind.Domain, domain: 'docs.acme.dev' })
    const session = await startTurn()

    const fetched = await starts(session, 'toolu_fetch', 'WebFetch', {
      url: 'https://paste.example/upload',
      prompt: 'x',
    })

    expect(fetched.settled()).toBe(false)
    expect(only('toolu_fetch').sandbox).toMatchObject({ kind: SandboxAskKind.Domain, domain: 'paste.example' })
    await answer('toolu_fetch', DENY)
    await expect(fetched.decision).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: true })
    // A granted domain is left to Claude Code, which has its rule.
    const granted = await starts(session, 'toolu_docs', 'WebFetch', { url: 'https://docs.acme.dev/x', prompt: 'x' })
    await expect(granted.decision).resolves.toBeNull()
  })

  it('leaves every call inside the bounds to Claude Code: nothing is asked, and nothing decided', async () => {
    grantToTask({ kind: SandboxGrantKind.Folder, path: SHARED, access: FolderAccess.ReadWrite })
    const session = await startTurn()

    const inside: [string, ToolInput][] = [
      ['Read', { file_path: `${ROOT}/README.md` }],
      ['Write', { file_path: 'src/retry.ts', content: 'x' }],
      ['Edit', { file_path: `${SHARED}/index.ts` }],
      ['Read', { file_path: '/etc/hosts' }],
      ['Grep', { pattern: 'TODO' }],
      ['Bash', { command: 'npm test' }],
      ['Monitor', { command: 'npm run dev' }],
    ]
    for (const [index, [toolName, input]] of inside.entries()) {
      const call = await starts(session, `toolu_in_${String(index)}`, toolName, input)
      await expect(call.decision).resolves.toBeNull()
    }

    expect(requests()).toEqual([])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
  })

  it('names the subagent whose call it stopped', async () => {
    const session = await startTurn()

    await starts(session, 'toolu_sub', 'Read', { file_path: `${LAUNCH_AGENTS}/x.plist` }, 'ac2cfaf3cec2364e5')

    expect(only('toolu_sub').agentId).toBe('ac2cfaf3cec2364e5')
  })

  it('withdraws the card when the call is cancelled while it waits', async () => {
    const session = await startTurn()
    const write = await starts(session, 'toolu_plist', 'Write', { file_path: PLIST, content: '<plist/>' })

    write.abort()
    await settle()

    await expect(write.decision).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: PERMISSION_WITHDRAWN_NOTE,
      byUser: false,
    })
    expect(only('toolu_plist').state).toBe(PermissionRequestState.Withdrawn)
  })

  it('decides nothing for a session that has closed', async () => {
    const session = await startTurn()
    runner.close()

    const write = session.startTool({ toolName: 'Write', toolUseId: 'toolu_late', input: { file_path: PLIST } })

    await expect(write.decision).resolves.toBeNull()
  })
})

describe('with the sandbox off', () => {
  it('gives the session no such hook: its calls are decided as they always were', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    const session = await startTurn()

    expect(session.options.hooks?.onToolStarting).toBeUndefined()
    expect(session.options.flagSettings).toBeUndefined()
    const write = session.startTool({ toolName: 'Write', toolUseId: 'toolu_plist', input: { file_path: PLIST } })
    await expect(write.decision).resolves.toBeNull()
    expect(requests()).toEqual([])
  })
})

describe('macOS’s magic folders', () => {
  // Finding 1: `Read /.nofollow/Users/me/.ssh/id_rsa` was `allow / none`, in either mode.
  it.each(BOTH_MODES)('are refused to the file tools without a card, in %s', async (mode) => {
    await setMode(mode)
    const session = await startTurn()
    const refused = { behavior: ToolPermissionBehavior.Deny, message: UNRESOLVABLE_REFUSAL, byUser: false }

    const paths = [
      `/.nofollow${HOME}/.ssh/id_rsa`,
      `/.vol/16777230/2${HOME}/.ssh/id_rsa`,
      `/.resolve/1${HOME}/.ssh/id_rsa`,
      `/.NOFOLLOW${HOME}/Documents/taxes.pdf`,
    ]
    for (const [index, path] of paths.entries()) {
      const read = await starts(session, `toolu_read_${String(index)}`, 'Read', { file_path: path })
      await expect(read.decision).resolves.toEqual(refused)
      const write = await starts(session, `toolu_write_${String(index)}`, 'Write', { file_path: path, content: 'x' })
      await expect(write.decision).resolves.toEqual(refused)
    }
    // And when Claude Code asks about one itself: refused, where it used to get the plain card, to allow once.
    const asked = session.requestPermission({
      toolUseId: 'toolu_read_0',
      toolName: 'Read',
      input: { file_path: `/.nofollow${HOME}/.ssh/id_rsa` },
    })
    await expect(asked.answer).resolves.toEqual(refused)

    expect(requests()).toEqual([])
    expect(UNRESOLVABLE_REFUSAL).toContain('/.nofollow, /.vol or /.resolve')
    // Each is marked as the sandbox's refusal, by the path the agent wrote.
    const marks = listPermissionMarks(database.db, task.id)
    expect(marks).toHaveLength(paths.length * 2)
    expect(marks[0]?.outcome).toEqual({
      kind: PermissionMarkKind.Blocked,
      ask: { kind: SandboxAskKind.Folder, path: `/.nofollow${HOME}/.ssh/id_rsa`, access: FolderAccess.Read },
    })
  })

  // Finding 1, the card that hid what it granted: `request_access("/.nofollow/Users/me", write)` opened a folder card
  // for `/.nofollow/Users/me`, where `request_access("/Users/me", write)` is refused as too much.
  it('are refused to request_access, with no card', async () => {
    const session = await startTurn()

    await asksAccess(session, 'toolu_alias', `/.nofollow${HOME}`, 'write')
    await asksAccess(session, 'toolu_vol', '/.vol/16777230/2/Users', 'read')

    expect(requests()).toEqual([])
    for (const toolUseId of ['toolu_alias', 'toolu_vol']) {
      expect(toolCall(toolUseId).state).toBe(ToolCallState.Error)
      expect(toolCall(toolUseId).output).toContain("Can't resolve")
    }
    expect(taskGrants()).toEqual([])
  })
})

describe('a granted folder swapped for a link', () => {
  // Finding 2: one innocuous card, then `rmdir ~/newcache && ln -s ~/Library/LaunchAgents ~/newcache` in a sandboxed
  // command (creating the granted path itself is allowed), then `Write ~/newcache/x.plist`: written with no card, since
  // Claude Code resolved its additional directory itself.
  it.each(BOTH_MODES)(
    'opens nothing to the file tools, in %s: the write asks, for where it really leads',
    async (mode) => {
      await setMode(mode)
      mkdirSync(CACHE)
      const session = await startTurn()
      const called = asksAccess(session, 'toolu_access', '~/newcache', 'write')
      await settle()
      expect(only('toolu_access').sandbox).toEqual({
        kind: SandboxAskKind.Folder,
        path: CACHE,
        access: FolderAccess.ReadWrite,
      })
      await answer('toolu_access', FOR_TASK)
      await called

      // Claude Code is told of no folder for its file tools: nothing it could resolve for itself.
      const overlay = session.flagSettings.at(-1)
      expect(overlay?.permissions).not.toHaveProperty('additionalDirectories')
      expect(overlay?.permissions?.allow).toEqual([])
      expect(overlay?.sandbox?.filesystem?.allowWrite).toEqual([ROOT, CACHE])
      expect(JSON.stringify(overlay?.permissions)).not.toContain('newcache')

      renameSync(CACHE, `${CACHE}.was`)
      symlinkSync(LAUNCH_AGENTS, CACHE)

      for (const [index, path] of [`${CACHE}/x.plist`, `${LAUNCH_AGENTS}/x.plist`].entries()) {
        const toolUseId = `toolu_write_${String(index)}`
        const write = await starts(session, toolUseId, 'Write', { file_path: path, content: '<plist/>' })
        expect(write.settled()).toBe(false)
        expect(only(toolUseId).sandbox).toEqual({
          kind: SandboxAskKind.Folder,
          path: LAUNCH_AGENTS,
          access: FolderAccess.ReadWrite,
        })
      }
      const read = await starts(session, 'toolu_read', 'Read', { file_path: `${CACHE}/x.plist` })
      expect(read.settled()).toBe(false)
      // And asked about through `canUseTool`, it's the same: nothing is let through for the grant.
      const asked = session.requestPermission({
        toolUseId: 'toolu_asked',
        toolName: 'Write',
        input: { file_path: `${CACHE}/y.plist`, content: '<plist/>' },
      })
      await settle()
      expect(only('toolu_asked').state).toBe(PermissionRequestState.Open)
      asked.abort()
    },
  )

  it('opens nothing when the path granted was missing, and was then made as a link', async () => {
    const session = await startTurn()
    const called = asksAccess(session, 'toolu_access', CACHE, 'write')
    await settle()
    await answer('toolu_access', FOR_TASK)
    await called
    expect(taskGrants()).toEqual([{ kind: SandboxGrantKind.Folder, path: CACHE, access: FolderAccess.ReadWrite }])

    symlinkSync(LAUNCH_AGENTS, CACHE)

    const write = await starts(session, 'toolu_write', 'Write', { file_path: `${CACHE}/x.plist`, content: '<plist/>' })
    expect(write.settled()).toBe(false)
    expect(only('toolu_write').sandbox).toMatchObject({ path: LAUNCH_AGENTS })
  })

  it('lets a write in a granted folder that’s still itself through, when Claude Code asks about it', async () => {
    mkdirSync(CACHE)
    grantToTask({ kind: SandboxGrantKind.Folder, path: CACHE, access: FolderAccess.ReadWrite })
    const session = await startTurn()

    const write = await starts(session, 'toolu_write', 'Write', { file_path: `${CACHE}/index.json`, content: '{}' })
    await expect(write.decision).resolves.toBeNull()
    const asked = session.requestPermission({
      toolUseId: 'toolu_write',
      toolName: 'Write',
      input: { file_path: `${CACHE}/index.json`, content: '{}' },
    })

    await expect(asked.answer).resolves.toEqual({ behavior: ToolPermissionBehavior.Allow, byUser: false })
    expect(requests()).toEqual([])
  })
})

describe('the files that run code', () => {
  // Finding 4: inside a folder granted read-write, a sandboxed command could write `.zshrc` and `.git/hooks`, and a
  // card for either offered the folder, or the file, for the task.
  it('stay write-protected for commands inside a folder granted read-write', async () => {
    grantToTask({ kind: SandboxGrantKind.Folder, path: SHARED, access: FolderAccess.ReadWrite })
    grantToTask({ kind: SandboxGrantKind.Folder, path: `${HOME}/code/notes`, access: FolderAccess.Read })

    const session = await startTurn()

    const denied = session.flagSettings.at(-1)?.sandbox?.filesystem?.denyWrite ?? []
    expect(denied).toEqual(expect.arrayContaining(protectedWrites(SHARED)))
    expect(denied).toContain(`${SHARED}/.zshrc`)
    expect(denied).toContain(`${SHARED}/.git/hooks`)
    expect(denied).toContain(`${SHARED}/.git/config`)
    expect(denied).toContain(`${SHARED}/**/.git/hooks/**`)
    expect(JSON.stringify(denied)).not.toContain('code/notes')
    // Nothing of the sort at start: there's no grant then.
    expect(JSON.stringify(session.options.flagSettings?.sandbox?.filesystem?.denyWrite)).not.toContain('.zshrc')
  })

  it.each(BOTH_MODES)(
    'are only ever allowed once to a file tool, in %s, inside a grant or outside every one',
    async (mode) => {
      await setMode(mode)
      grantToTask({ kind: SandboxGrantKind.Folder, path: SHARED, access: FolderAccess.ReadWrite })
      const session = await startTurn()

      const hook = await starts(session, 'toolu_hook', 'Write', {
        file_path: `${SHARED}/.git/hooks/pre-commit`,
        content: 'x',
      })
      await starts(session, 'toolu_zshrc', 'Edit', { file_path: '~/.zshrc' })

      for (const toolUseId of ['toolu_hook', 'toolu_zshrc']) {
        // The plain card: no folder, no file, no rule to remember.
        expect(only(toolUseId)).toMatchObject({
          state: PermissionRequestState.Open,
          sandbox: null,
          suppressAlwaysAllowRule: true,
        })
        await expect(answer(toolUseId, FOR_TASK)).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
      }
      await answer('toolu_hook', ONCE)
      await expect(hook.decision).resolves.toEqual(ALLOWED_BY_YOU)
      expect(taskGrants()).toHaveLength(1)
      // The next write to it asks again.
      const again = await starts(session, 'toolu_again', 'Write', {
        file_path: `${SHARED}/.git/hooks/pre-commit`,
        content: 'y',
      })
      expect(again.settled()).toBe(false)
    },
  )

  it('are refused to request_access for a write, with no card, and say why', async () => {
    grantToTask({ kind: SandboxGrantKind.Folder, path: SHARED, access: FolderAccess.ReadWrite })
    const session = await startTurn()

    await asksAccess(session, 'toolu_hooks', `${SHARED}/.git/hooks`, 'write')
    await asksAccess(session, 'toolu_zshrc', '~/.zshrc', 'write')

    expect(requests()).toEqual([])
    for (const toolUseId of ['toolu_hooks', 'toolu_zshrc']) {
      expect(toolCall(toolUseId).state).toBe(ToolCallState.Error)
      expect(toolCall(toolUseId).output).toContain('is one of the files that run code later')
    }
    expect(
      listPermissionMarks(database.db, task.id).map(({ toolUseId, outcome }) => [toolUseId, outcome.kind]),
    ).toEqual([
      ['toolu_hooks', PermissionMarkKind.Blocked],
      ['toolu_zshrc', PermissionMarkKind.Blocked],
    ])
  })
})

describe('a command the user’s settings keep out of the sandbox', () => {
  /** The repository's own `.claude/settings.json`: `excludedCommands` is honoured from project settings too. */
  function exclude(patterns: readonly string[]): void {
    mkdirSync(`${ROOT}/.claude`, { recursive: true })
    writeFileSync(`${ROOT}/.claude/settings.json`, JSON.stringify({ sandbox: { excludedCommands: patterns } }))
  }
  const DOCKER = { command: 'docker run -v ~:/h alpine cat /h/.ssh/id_rsa', description: 'Run the sample' }

  // Finding 3: `sandbox.excludedCommands: ["docker *"]` runs the command outside the sandbox, with no
  // `dangerouslyDisableSandbox`. In Allow all, Glade answered allow: no card, unsandboxed.
  it.each(BOTH_MODES)('asks to run outside the sandbox, in %s, and can only be allowed once', async (mode) => {
    await setMode(mode)
    exclude(['docker *'])
    // A rule granted for the task doesn't make the next one silent.
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Bash', ruleContent: 'docker *' } })
    const session = await startTurn()

    const run = await starts(session, 'toolu_docker', 'Bash', DOCKER)

    expect(run.settled()).toBe(false)
    expect(only('toolu_docker')).toMatchObject({
      state: PermissionRequestState.Open,
      toolName: 'Bash',
      input: DOCKER,
      suppressAlwaysAllowRule: true,
      sandbox: { kind: SandboxAskKind.Outside },
    })
    await expect(answer('toolu_docker', FOR_TASK)).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    await answer('toolu_docker', ONCE)
    await expect(run.decision).resolves.toEqual(ALLOWED_BY_YOU)

    // It asks every time, and a watcher's command the same.
    const again = await starts(session, 'toolu_again', 'Bash', DOCKER)
    expect(again.settled()).toBe(false)
    await answer('toolu_again', DENY)
    await expect(again.decision).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny, byUser: true })
    const watch = await starts(session, 'toolu_watch', 'Monitor', { command: 'docker logs -f api' })
    expect(watch.settled()).toBe(false)
    expect(only('toolu_watch').sandbox).toEqual({ kind: SandboxAskKind.Outside })
    // Any other command runs in the sandbox, and isn't asked about here.
    const test = await starts(session, 'toolu_test', 'Bash', { command: 'npm test' })
    await expect(test.decision).resolves.toBeNull()
  })

  it('is refused once the sandbox couldn’t start: nothing runs unsandboxed', async () => {
    exclude(['docker *'])
    const session = await startTurn()
    await session.finishBash({
      toolUseId: 'toolu_first',
      command: 'npm test',
      output: sandboxInitFailure('sandbox-exec: not found'),
      failed: true,
    }).answer

    const run = await starts(session, 'toolu_docker', 'Bash', DOCKER)

    await expect(run.decision).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: SANDBOX_FAILED_REFUSAL,
      byUser: false,
    })
    expect(requests()).toEqual([])
  })

  it('reads none of the machine’s settings unless the app says where they are', async () => {
    runner.close()
    backend = new FakeAgentBackend()
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
    }))
    glade = createBridge(ipc.renderer)
    exclude(['docker *'])
    const session = await startTurn()

    const run = await starts(session, 'toolu_docker', 'Bash', DOCKER)

    await expect(run.decision).resolves.toBeNull()
  })
})

describe('a command asking to run outside the sandbox', () => {
  const OVERRIDE = { command: 'docker compose up -d db', dangerouslyDisableSandbox: true }

  it('is decided in the hook, and Claude Code asking about it afterwards gets the same answer, with no second card', async () => {
    const session = await startTurn()

    const run = await starts(session, 'toolu_up', 'Bash', OVERRIDE)
    expect(only('toolu_up').sandbox).toEqual({ kind: SandboxAskKind.Outside })
    await answer('toolu_up', ONCE)
    await expect(run.decision).resolves.toEqual(ALLOWED_BY_YOU)

    // Glade's own ask rule has Claude Code ask about the call anyway, whatever a hook allowed.
    const asked = session.requestPermission(sandboxOverrideCall('toolu_up', OVERRIDE, true))
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(requests()).toHaveLength(1)

    // Once: asked about again under the same id, it's decided afresh.
    const later = session.requestPermission(sandboxOverrideCall('toolu_up', OVERRIDE, true))
    await settle()
    expect(requests()).toHaveLength(2)
    later.abort()
  })

  it('forgets the oldest of the calls it let through, past the few it keeps', async () => {
    const session = await startTurn()
    for (let index = 0; index <= 20; index += 1) {
      const toolUseId = `toolu_up_${String(index)}`
      const run = await starts(session, toolUseId, 'Bash', OVERRIDE)
      await answer(toolUseId, ONCE)
      await expect(run.decision).resolves.toEqual(ALLOWED_BY_YOU)
    }

    // The latest is answered as its hook decided; the first has been forgotten, and asks again.
    const latest = session.requestPermission(sandboxOverrideCall('toolu_up_20', OVERRIDE, true))
    await expect(latest.answer).resolves.toEqual(ALLOWED_BY_YOU)
    const first = session.requestPermission(sandboxOverrideCall('toolu_up_0', OVERRIDE, true))
    await settle()
    expect(requests().filter((request) => request.state === PermissionRequestState.Open)).toHaveLength(1)
    first.abort()
  })
})

describe('Glade’s own data folder', () => {
  // Finding 8: a read-write grant of `~/Library` let a command write Glade's database, and turn the sandbox off.
  it('is shut to commands and file tools from the start, and stays shut inside a granted folder', async () => {
    grantToTask({ kind: SandboxGrantKind.Folder, path: `${HOME}/Library`, access: FolderAccess.ReadWrite })
    const session = await startTurn()

    for (const settings of [session.options.flagSettings, session.flagSettings.at(-1)]) {
      expect(settings?.sandbox?.filesystem?.denyWrite).toContain(DATA)
      expect(settings?.sandbox?.credentials?.files).toContainEqual({ path: DATA, mode: 'deny' })
      expect(settings?.permissions?.deny).toContain(`Read(/${DATA}/**)`)
      expect(settings?.permissions?.deny).toContain(`Edit(/${DATA}/**)`)
    }
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem?.allowWrite).toEqual([ROOT, `${HOME}/Library`])

    const read = await starts(session, 'toolu_db', 'Read', { file_path: `${DATA}/glade.db` })
    const write = await starts(session, 'toolu_db_write', 'Write', { file_path: `${DATA}/glade.db`, content: 'x' })
    for (const call of [read, write]) {
      await expect(call.decision).resolves.toMatchObject({
        behavior: ToolPermissionBehavior.Deny,
        message: CREDENTIAL_REFUSAL,
      })
    }
    // What's beside it in the granted folder is as granted.
    const beside = await starts(session, 'toolu_cache', 'Write', {
      file_path: `${HOME}/Library/Caches/uv/x`,
      content: 'x',
    })
    await expect(beside.decision).resolves.toBeNull()
    expect(requests()).toEqual([])
  })

  it('keeps the control endpoint’s URL and token from commands, in every session', async () => {
    const session = await startTurn()
    const denied = [
      { name: 'GLADE_CONTROL_URL', mode: 'deny' },
      { name: 'GLADE_CONTROL_TOKEN', mode: 'deny' },
    ]
    expect(session.options.flagSettings?.sandbox?.credentials?.envVars).toEqual(denied)
    expect(session.flagSettings.at(-1)?.sandbox?.credentials?.envVars).toEqual(denied)
  })
})
