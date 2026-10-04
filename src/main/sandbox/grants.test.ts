// Sandbox grants (P15-04, #449): kept per task, per workspace and Glade-wide, read by a sandboxed session as it starts
// or resumes, and again by every running session a change covers, which decides its calls against them and takes the
// whole overlay (`../agent/sandbox`'s real builder) without restarting. A fake agent session behind the real bridge,
// saving to a database in a temporary folder. The home folder is a temporary one too, so the paths the sandbox
// resolves are never the machine's own.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import {
  AgentErrorKind,
  Effort,
  PermissionMode,
  TaskActivity,
  TaskErrorSource,
  UiStateKey,
  type PermissionRequest,
  type Task,
  type Workspace,
} from '../../shared/domain'
import {
  FolderAccess,
  OtherAgents,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import { ToolPermissionBehavior, type SandboxFlagSettings, type ToolPermissionAnswer } from '../agent/backend'
import {
  FakeAgentBackend,
  settle,
  type AskedPermission,
  type FakeAgentSession,
  type PermissionCallFields,
} from '../agent/fake-backend'
import { RESUME_PROMPT, SANDBOX_NOT_APPLIED, type AgentRunner } from '../agent/runner'
import { NO_GRANTS, sandboxOverlay, sandboxStartSettings, usableGrants } from '../agent/sandbox'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge } from '../bridge'
import { CommandFailure } from '../bridge/errors'
import type { Emit } from '../bridge/events'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { addSandboxGrant, listSandboxGrants, SandboxGrantChange } from '../db/repositories/sandbox-grants'
import { updateSettings } from '../db/repositories/settings'
import { addTaskPermissionRule } from '../db/repositories/task-permission-rules'
import { createTask, getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { createWorkspace } from '../db/repositories/workspaces'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { pathKey } from '../permissions/canonical-path'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import {
  changeSandboxFolderAccess,
  grantedDomain,
  grantedFolder,
  grantingGrant,
  heldGrants,
  grantSandboxAccess,
  hasMoved,
  revokeSandboxGrant,
  saveCardGrant,
  saveSandboxGrant,
  sandboxGrantsOf,
  taskSandboxGrants,
  type GrantedUse,
  type SandboxGrantsContext,
} from './grants'

/** A home folder of the tests' own, made before anything reads where home is. */
const FAKE_HOME = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'glade-home-')))
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => FAKE_HOME }
  return { ...mocked, default: mocked }
})

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
})

const read = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.Read })
const readWrite = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.ReadWrite })
const domain = (host: string): Grant => ({ kind: SandboxGrantKind.Domain, domain: host })
const server = (key: string, name = key): Grant => ({ kind: SandboxGrantKind.McpServer, server: key, name })
const agents = (which: OtherAgents): Grant => ({ kind: SandboxGrantKind.Agents, agents: which })
const folderKey = (path: string) => ({ kind: SandboxGrantKind.Folder, path }) as const

const GLADE: SandboxGrantTarget = { scope: SandboxGrantScope.Glade }

/** Whether the temp folder's disk takes a name in any case, as APFS does by default: Linux runners' don't. */
const CASE_INSENSITIVE_DISK = existsSync(tmpdir().toUpperCase())

const HOME = homedir()
const ROOT = `${HOME}/src/acme-api`
const OTHER_ROOT = `${HOME}/src/acme-web`
/** Folders under the home folder, which nothing may read until they're granted. None exists. */
const NOTES = `${HOME}/notes`
const SHARED = `${HOME}/shared`
const DOCS = `${HOME}/docs`
const TOOLCHAIN = `${HOME}/.toolchain`

const ALLOWED_AT_ONCE: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: false }
const NOT_APPLIED = `${SANDBOX_NOT_APPLIED}settings_not_applied`

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let runner: AgentRunner
let emit: Emit
let glade: GladeBridge
let log: MemoryLog
let grants: SandboxGrantsContext

/** Starts the app on the database, as a launch does: its runner reads the grants' store. */
function launch(): void {
  backend = new FakeAgentBackend()
  log = createMemoryLog()
  const ipc = fakeIpcPair()
  ;({ runner, emit } = registerBridge({
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
  grants = { db: database.db, runner, emit }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  database = openTestDatabase()
  // The sandbox is off by default until P15's last PR: every test here but the one that says otherwise turns it on.
  updateSettings(database.db, { sandboxEnabled: true })
  workspace = sampleWorkspace(database.db, ROOT)
  task = sampleTask(database.db, workspace.id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

const taskTarget = (id = task.id): SandboxGrantTarget => ({ scope: SandboxGrantScope.Task, taskId: id })
const workspaceTarget = (id = workspace.id): SandboxGrantTarget => ({
  scope: SandboxGrantScope.Workspace,
  workspaceId: id,
})

/** The overlay the real builder makes for a task with these grants, in its root and mode. */
function overlay(given: readonly Grant[], root = ROOT, mode = PermissionMode.AllowAll): SandboxFlagSettings {
  return sandboxOverlay(root, mode, sandboxGrantsOf(given))
}

function current(id = task.id): Task {
  const found = getTask(database.db, id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** Sends a task a message, starting its session, and lets the session say it's started. */
async function startTask(id = task.id): Promise<FakeAgentSession> {
  runner.send(id, 'Find out why the login test is flaky.')
  const session = backend.session
  session.emit(sdk.init(`session-${id}`))
  await settle()
  return session
}

/** Ends the task's running turn. */
async function finishTurn(session: FakeAgentSession): Promise<void> {
  session.emit(sdk.result('Done.'))
  await settle()
}

/** The agent calls a tool, and Claude Code asks about it: the `tool_use`, then `canUseTool`. */
async function callTool(session: FakeAgentSession, fields: PermissionCallFields): Promise<AskedPermission> {
  session.emit(sdk.toolUse(fields.toolUseId, fields.toolName, { ...fields.input }))
  await settle()
  const asked = session.requestPermission(fields)
  await settle()
  return asked
}

/** The tool calls a task was asked about, by their ids. */
function asked(id = task.id): string[] {
  return listPermissionRequests(database.db, id).map(({ toolUseId }: PermissionRequest) => toolUseId)
}

function anotherTask(workspaceId = workspace.id, now = 3_000): Task {
  return createTask(database.db, { workspaceId, model: 'claude-sample-1', effort: Effort.Medium }, now)
}

function otherWorkspace(): Workspace {
  return createWorkspace(database.db, { name: 'Acme Web', rootPath: OTHER_ROOT }, 1_000)
}

/** Has a session refuse every overlay from now on, as the SDK would. */
function refuseOverlays(session: FakeAgentSession): void {
  session.onApplyFlagSettings = () => Promise.reject(new Error('settings_not_applied'))
}

const NOTHING = { applied: [], closed: [], pending: [] }

/** What a grant was refused with: an `invalid_request` failure's message. Throws if it wasn't refused that way. */
function refusalOf(grant: () => unknown): string {
  try {
    grant()
  } catch (error) {
    if (error instanceof CommandFailure && error.code === BridgeErrorCode.InvalidRequest) return error.message
    throw error
  }
  throw new Error('The grant was not refused')
}

describe('a session starting', () => {
  it('starts with no grant in its options, and gets every scope’s through one overlay before its first message', async () => {
    addSandboxGrant(database.db, { target: GLADE, grant: read(TOOLCHAIN) }, 10)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite(SHARED) }, 11)
    addSandboxGrant(database.db, { target: taskTarget(), grant: domain('registry.npmjs.org') }, 12)
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Bash', ruleContent: 'npm test *' } })
    const sentBeforeEachOverlay: number[] = []
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () => {
        sentBeforeEachOverlay.push(session.sent.length)
        return Promise.resolve()
      }
    }

    const session = await startTask()

    // Only the fixed parts at start: what a later overlay could never take back.
    expect(session.options.flagSettings).toEqual(sandboxStartSettings(ROOT))
    expect(JSON.stringify(session.options.flagSettings)).not.toMatch(/\.toolchain|shared|npmjs/)
    expect(session.options.allowedRules).toEqual([{ toolName: 'Bash', ruleContent: 'npm test *' }])
    expect(session.flagSettings).toEqual([overlay([read(TOOLCHAIN), readWrite(SHARED), domain('registry.npmjs.org')])])
    expect(session.flagSettings[0]).toMatchObject({
      sandbox: { filesystem: { allowRead: [ROOT, TOOLCHAIN, SHARED], allowWrite: [ROOT, SHARED] } },
      // The file tools are told of no folder (#514): only a domain is a rule, since commands' connections need it.
      permissions: { allow: ['WebFetch(domain:registry.npmjs.org)'] },
    })
    expect(session.flagSettings[0]?.permissions).not.toHaveProperty('additionalDirectories')
    // What runs code stays write-protected in the folder granted read-write.
    expect(session.flagSettings[0]?.sandbox?.filesystem?.denyWrite).toContain(`${SHARED}/.git/hooks`)
    expect(sentBeforeEachOverlay).toEqual([0])
    expect(session.sent).toHaveLength(1)
    // Everything saved went into the sandbox: nothing was left out.
    expect(log.withMessage('left a grant out of the sandbox')).toEqual([])
  })

  it('still applies the fixed parts with nothing granted at all', async () => {
    const session = await startTask()

    expect(session.flagSettings).toEqual([sandboxOverlay(ROOT, PermissionMode.AllowAll, NO_GRANTS)])
    expect(session.flagSettings[0]?.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      filesystem: { denyRead: [HOME, '/Users', '/Volumes'], allowRead: [ROOT], allowWrite: [ROOT] },
      network: { allowedDomains: [] },
    })
    expect(session.flagSettings[0]?.sandbox?.credentials?.files).toContainEqual({ path: `${HOME}/.ssh`, mode: 'deny' })
    expect(session.flagSettings[0]?.permissions).toMatchObject({ allow: [] })
    expect(session.flagSettings[0]?.permissions).not.toHaveProperty('additionalDirectories')
  })

  it('applies nothing to a session that started with the sandbox off, then or when the grants change', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    addSandboxGrant(database.db, { target: GLADE, grant: read(TOOLCHAIN) })

    const session = await startTask()
    const outcome = await grantSandboxAccess(grants, { target: GLADE, grant: domain('acme.dev') })

    expect(outcome).toEqual({ change: SandboxGrantChange.Added, sessions: NOTHING })
    expect(session.flagSettings).toEqual([])
    expect(session.options.flagSettings).toBeUndefined()
    expect(session.closed).toBe(false)
  })

  it('keeps domain grants out of the start options: only WebFetch rules in the overlay’s permissions.allow', async () => {
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: domain('registry.npmjs.org') })
    addSandboxGrant(database.db, { target: taskTarget(), grant: domain('*.acme.dev') })

    const session = await startTask()

    const [applied] = session.flagSettings
    expect(applied?.permissions?.allow).toEqual(['WebFetch(domain:registry.npmjs.org)', 'WebFetch(domain:*.acme.dev)'])
    expect(applied?.sandbox?.network).toMatchObject({ allowedDomains: [] })
    expect(JSON.stringify([session.options.flagSettings, session.options.allowedRules])).not.toMatch(/acme\.dev|npmjs/)
    expect(session.options.allowedRules).toEqual([])
  })

  it('gets the same overlay when it resumes after a relaunch', async () => {
    addSandboxGrant(database.db, { target: GLADE, grant: read(TOOLCHAIN) }, 10)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: domain('registry.npmjs.org') }, 11)
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite(NOTES) }, 12)
    const first = await startTask()
    await finishTurn(first)

    runner.close()
    launch()
    runner.send(task.id, 'Carry on.')
    await settle()

    const resumed = backend.session
    expect(resumed.options.resumeSessionId).toBe(`session-${task.id}`)
    expect(resumed.options.flagSettings).toEqual(sandboxStartSettings(ROOT))
    expect(resumed.flagSettings).toEqual(first.flagSettings)
    expect(resumed.flagSettings).toEqual([overlay([read(TOOLCHAIN), domain('registry.npmjs.org'), readWrite(NOTES)])])
  })

  it('gets the grants when a turn the app quit in resumes on launch, before it’s told to carry on', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: read(NOTES) })
    await startTask()
    expect(current().activity).toBe(TaskActivity.Working)

    runner.close()
    launch()
    const sentBeforeOverlay: number[] = []
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () => {
        sentBeforeOverlay.push(session.sent.length)
        return Promise.resolve()
      }
    }
    expect(runner.resumeInterrupted()).toEqual([task.id])
    await settle()

    expect(backend.session.flagSettings).toEqual([overlay([read(NOTES)])])
    expect(sentBeforeOverlay).toEqual([0])
    expect(backend.session.sent.map(({ text }) => text)).toEqual([RESUME_PROMPT])
  })

  it('never runs a session that won’t take its grants: it’s closed unsent, and the next start has them', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: read(NOTES) })
    backend.onSessionStart = refuseOverlays

    runner.send(task.id, 'Read my notes.')
    await settle()

    const refused = backend.session
    expect(refused.flagSettings).toEqual([overlay([read(NOTES)])])
    expect(refused.sent).toEqual([])
    expect(refused.closed).toBe(true)
    expect(current()).toMatchObject({
      activity: TaskActivity.Error,
      error: { kind: AgentErrorKind.Permanent, source: TaskErrorSource.Sandbox, details: NOT_APPLIED },
    })

    backend.onSessionStart = () => undefined
    await glade.invoke(CommandName.TasksRetry, { id: task.id })
    await settle()

    expect(backend.sessions).toHaveLength(2)
    expect(backend.session.flagSettings).toEqual([overlay([read(NOTES)])])
    expect(backend.session.sent).toHaveLength(1)
  })
})

describe('a grant changing while sessions run', () => {
  it('applies a workspace grant to exactly the running tasks in that workspace, restarting none', async () => {
    const sibling = anotherTask()
    const elsewhere = anotherTask(otherWorkspace().id, 4_000)
    const idle = anotherTask(workspace.id, 5_000)
    const first = await startTask(task.id)
    const second = await startTask(sibling.id)
    const third = await startTask(elsewhere.id)

    const outcome = await grantSandboxAccess(grants, { target: workspaceTarget(), grant: readWrite(SHARED) })

    expect(outcome).toEqual({
      change: SandboxGrantChange.Added,
      sessions: { applied: [task.id, sibling.id], closed: [], pending: [] },
    })
    expect(first.flagSettings).toEqual([overlay([]), overlay([readWrite(SHARED)])])
    expect(second.flagSettings).toEqual([overlay([]), overlay([readWrite(SHARED)])])
    expect(third.flagSettings).toEqual([overlay([], OTHER_ROOT)])
    // No restarts: the same three sessions, none closed, and none started for the task that isn't running.
    expect(backend.sessions).toEqual([first, second, third])
    expect(backend.sessions.some(({ closed }) => closed)).toBe(false)
    expect(listSandboxGrants(database.db, workspaceTarget()).map(({ grant }) => grant)).toEqual([readWrite(SHARED)])
    expect(log.withMessage('sandbox grants changed').map(({ fields }) => fields)).toEqual([
      { taskId: task.id, folders: 1, domains: 0, servers: 0, agents: 0 },
      { taskId: sibling.id, folders: 1, domains: 0, servers: 0, agents: 0 },
    ])
    // The idle task in the workspace gets it as soon as it starts.
    const started = await startTask(idle.id)
    expect(started.flagSettings).toEqual([overlay([readWrite(SHARED)])])
  })

  it('applies a Glade-wide grant to every running task, each in its own root', async () => {
    const elsewhere = anotherTask(otherWorkspace().id, 4_000)
    const first = await startTask(task.id)
    const second = await startTask(elsewhere.id)

    await grantSandboxAccess(grants, { target: GLADE, grant: read(TOOLCHAIN) })

    expect(first.flagSettings.at(-1)).toEqual(overlay([read(TOOLCHAIN)]))
    expect(second.flagSettings.at(-1)).toEqual(overlay([read(TOOLCHAIN)], OTHER_ROOT))
  })

  it('applies a task grant to that task’s session only', async () => {
    const sibling = anotherTask()
    const first = await startTask(task.id)
    const second = await startTask(sibling.id)

    await grantSandboxAccess(grants, { target: taskTarget(sibling.id), grant: domain('acme.dev') })

    expect(first.flagSettings).toEqual([overlay([])])
    expect(second.flagSettings).toEqual([overlay([]), overlay([domain('acme.dev')])])
  })

  it('saves a grant for a task that isn’t running, and applies it when the task starts', async () => {
    const outcome = await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite(NOTES) })

    expect(outcome).toEqual({ change: SandboxGrantChange.Added, sessions: NOTHING })
    expect(backend.sessions).toEqual([])
    const session = await startTask()
    expect(session.flagSettings).toEqual([overlay([readWrite(NOTES)])])
  })

  it('saves a duplicate grant once, and applies the grants again all the same', async () => {
    const session = await startTask()
    await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite(NOTES) })

    const again = await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite(NOTES) })
    const narrower = await grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })

    const sessions = { applied: [task.id], closed: [], pending: [] }
    expect(again).toEqual({ change: SandboxGrantChange.Unchanged, sessions })
    expect(narrower).toEqual({ change: SandboxGrantChange.Unchanged, sessions })
    expect(listSandboxGrants(database.db, taskTarget())).toHaveLength(1)
    const withNotes = overlay([readWrite(NOTES)])
    expect(session.flagSettings).toEqual([overlay([]), withNotes, withNotes, withNotes])
  })

  it('upgrades a read-only folder granted read-write, live', async () => {
    const session = await startTask()
    await grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })
    expect(session.flagSettings.at(-1)).toEqual(overlay([read(NOTES)]))
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem).toMatchObject({
      allowRead: [ROOT, NOTES],
      allowWrite: [ROOT],
    })

    expect(await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite(NOTES) })).toMatchObject({
      change: SandboxGrantChange.Changed,
    })

    const upgraded = session.flagSettings.at(-1)
    expect(upgraded).toEqual(overlay([readWrite(NOTES)]))
    expect(upgraded?.sandbox?.filesystem).toMatchObject({ allowRead: [ROOT, NOTES], allowWrite: [ROOT, NOTES] })
    expect(upgraded?.sandbox?.filesystem?.denyWrite).toContain(`${NOTES}/.zshrc`)
    expect(upgraded?.permissions).toMatchObject({ allow: [] })
  })

  it('takes a removed folder out of every list of the overlay', async () => {
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite(SHARED) }, 10)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: read(DOCS) }, 11)
    const session = await startTask()
    expect(JSON.stringify(session.flagSettings[0])).toContain(SHARED)

    expect(await revokeSandboxGrant(grants, workspaceTarget(), folderKey(SHARED))).toMatchObject({ removed: true })
    expect(await revokeSandboxGrant(grants, workspaceTarget(), folderKey(DOCS))).toMatchObject({ removed: true })

    const [, withoutShared, withoutEither] = session.flagSettings
    expect(withoutShared).toEqual(overlay([read(DOCS)]))
    expect(JSON.stringify(withoutShared)).not.toContain(SHARED)
    expect(withoutEither).toEqual(overlay([]))
    expect(withoutEither?.sandbox?.filesystem).toMatchObject({ allowRead: [ROOT], allowWrite: [ROOT] })
    expect(withoutEither?.permissions).toMatchObject({ allow: [] })
    expect(JSON.stringify(withoutEither)).not.toContain(SHARED)
    expect(backend.sessions).toEqual([session])
  })

  it('downgrades a read-write folder to read-only: out of allowWrite, and its write-protected files with it', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite(NOTES) })
    const session = await startTask()

    expect(await changeSandboxFolderAccess(grants, taskTarget(), NOTES, FolderAccess.Read)).toMatchObject({
      change: SandboxGrantChange.Changed,
    })

    const downgraded = session.flagSettings.at(-1)
    expect(downgraded).toEqual(overlay([read(NOTES)]))
    expect(downgraded?.sandbox?.filesystem).toMatchObject({ allowRead: [ROOT, NOTES], allowWrite: [ROOT] })
    expect(session.flagSettings[0]?.sandbox?.filesystem?.denyWrite).toContain(`${NOTES}/.zshrc`)
    expect(downgraded?.sandbox?.filesystem?.denyWrite).not.toContain(`${NOTES}/.zshrc`)
    expect(downgraded?.permissions).toMatchObject({ allow: [] })
  })

  it('keeps a folder read-write while another scope still grants it so', async () => {
    addSandboxGrant(database.db, { target: GLADE, grant: readWrite(TOOLCHAIN) })
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite(TOOLCHAIN) })
    const session = await startTask()

    await changeSandboxFolderAccess(grants, taskTarget(), TOOLCHAIN, FolderAccess.Read)
    expect(session.flagSettings.at(-1)).toEqual(overlay([readWrite(TOOLCHAIN)]))

    await revokeSandboxGrant(grants, GLADE, folderKey(TOOLCHAIN))
    expect(session.flagSettings.at(-1)).toEqual(overlay([read(TOOLCHAIN)]))
  })

  it('removes a domain from permissions.allow', async () => {
    addSandboxGrant(database.db, { target: GLADE, grant: domain('registry.npmjs.org') })
    addSandboxGrant(database.db, { target: GLADE, grant: domain('acme.dev') })
    const session = await startTask()

    await revokeSandboxGrant(grants, GLADE, { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' })

    expect(session.flagSettings.at(-1)?.permissions?.allow).toEqual(['WebFetch(domain:acme.dev)'])
  })

  it('applies the grants again for a change that changes nothing, and says nothing changed', async () => {
    const session = await startTask()
    const sessions = { applied: [task.id], closed: [], pending: [] }

    expect(await revokeSandboxGrant(grants, taskTarget(), folderKey(NOTES))).toEqual({ removed: false, sessions })
    expect(await changeSandboxFolderAccess(grants, taskTarget(), NOTES, FolderAccess.Read)).toEqual({
      change: SandboxGrantChange.Unchanged,
      sessions,
    })
    expect(session.flagSettings).toEqual([overlay([]), overlay([]), overlay([])])
  })

  it('applies a grant mid-turn, without stopping or restarting the turn', async () => {
    const session = await startTask()
    expect(current().activity).toBe(TaskActivity.Working)

    await grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })

    expect(session.flagSettings.at(-1)).toEqual(overlay([read(NOTES)]))
    expect(session.interrupts).toBe(0)
    expect(current().activity).toBe(TaskActivity.Working)
    await finishTurn(session)
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(backend.sessions).toEqual([session])
  })

  it('applies a grant between turns, to the session that waits for the next one', async () => {
    const session = await startTask()
    await finishTurn(session)

    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: domain('acme.dev') })
    runner.send(task.id, 'Now fetch the docs.')
    await settle()

    expect(session.flagSettings.at(-1)).toEqual(overlay([domain('acme.dev')]))
    expect(backend.sessions).toEqual([session])
    expect(session.sent).toHaveLength(2)
  })

  it('resolves only once the session has the grant, so a card answers the agent after it’s applied', async () => {
    const session = await startTask()
    let applied = (): void => undefined
    session.onApplyFlagSettings = () =>
      new Promise<void>((resolve) => {
        applied = resolve
      })

    let resolved = false
    const granting = grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) }).then(() => {
      resolved = true
    })
    await settle()
    expect(session.flagSettings).toHaveLength(2)
    expect(resolved).toBe(false)

    applied()
    await granting
    expect(resolved).toBe(true)
  })

  it('takes a grant removed while the session starts out of what it ends up with', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: read(NOTES) }, 10)
    addSandboxGrant(database.db, { target: taskTarget(), grant: domain('acme.dev') }, 11)
    // The first overlay hasn't finished applying when the grant goes: the session's message still waits on it.
    let firstApplied = (): void => undefined
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () =>
        new Promise<void>((resolve) => {
          firstApplied = resolve
        })
    }
    runner.send(task.id, 'Read my notes.')
    const session = backend.session
    session.onApplyFlagSettings = () => Promise.resolve()

    await revokeSandboxGrant(grants, taskTarget(), folderKey(NOTES))
    expect(session.sent).toEqual([])
    firstApplied()
    await settle()

    // Applied in order, so the session ends up with the second, the whole overlay without the grant.
    expect(session.flagSettings).toEqual([overlay([read(NOTES), domain('acme.dev')]), overlay([domain('acme.dev')])])
    expect(session.sent).toHaveLength(1)
  })

  it('applies many grants as one overlay each time', async () => {
    const session = await startTask()
    const many: Grant[] = []
    for (let index = 0; index < 50; index += 1) {
      many.push(read(`${HOME}/tools/tool-${String(index)}`), domain(`host-${String(index)}.acme.dev`))
    }
    for (const grant of many) await grantSandboxAccess(grants, { target: workspaceTarget(), grant })

    expect(session.flagSettings).toHaveLength(101)
    expect(session.flagSettings.at(-1)).toEqual(overlay(many))
    expect(session.flagSettings.at(-1)?.permissions?.allow).toHaveLength(50)
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem?.allowRead).toHaveLength(51)
    expect(log.withMessage('left a grant out of the sandbox')).toEqual([])
  })

  it('leaves a session the app closed alone', async () => {
    await startTask()
    runner.close()

    const outcome = await grantSandboxAccess(grants, { target: GLADE, grant: domain('acme.dev') })

    expect(outcome.sessions).toEqual(NOTHING)
    expect(backend.session.flagSettings).toEqual([overlay([])])
  })
})

describe('a mode switch', () => {
  async function setMode(permissionMode: PermissionMode): Promise<void> {
    await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { permissionMode } })
    await settle()
  }

  it('keeps the grants the session started with in its overlay', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: read(NOTES) }, 10)
    addSandboxGrant(database.db, { target: GLADE, grant: domain('registry.npmjs.org') }, 11)
    const session = await startTask()

    await setMode(PermissionMode.AskBeforeEdits)

    const given = [read(NOTES), domain('registry.npmjs.org')]
    expect(session.flagSettings).toEqual([overlay(given), overlay(given, ROOT, PermissionMode.AskBeforeEdits)])
    expect(session.flagSettings.at(-1)?.sandbox?.autoAllowBashIfSandboxed).toBe(false)
    expect(session.flagSettings.at(-1)?.permissions?.allow).toEqual(['WebFetch(domain:registry.npmjs.org)'])
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem?.allowRead).toEqual([ROOT, NOTES])
  })

  it('keeps the grants as they are now, after they changed while the session ran', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite(NOTES) })
    const session = await startTask()
    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: read(DOCS) })
    await revokeSandboxGrant(grants, taskTarget(), folderKey(NOTES))

    await setMode(PermissionMode.AskBeforeEdits)
    await setMode(PermissionMode.AllowAll)

    expect(session.flagSettings.slice(-2)).toEqual([
      overlay([read(DOCS)], ROOT, PermissionMode.AskBeforeEdits),
      overlay([read(DOCS)]),
    ])
    expect(JSON.stringify(session.flagSettings.slice(-2))).not.toContain(NOTES)
  })

  it('carries the new mode into the overlay a later grant change sends', async () => {
    const session = await startTask()
    await setMode(PermissionMode.AskBeforeEdits)

    await grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })

    expect(session.flagSettings.at(-1)).toEqual(overlay([read(NOTES)], ROOT, PermissionMode.AskBeforeEdits))
  })
})

describe('what a running session’s calls are decided against', () => {
  const readNotes = (toolUseId: string): PermissionCallFields => ({
    toolUseId,
    toolName: 'Read',
    input: { file_path: `${NOTES}/a.md` },
  })
  const writeNotes = (toolUseId: string): PermissionCallFields => ({
    toolUseId,
    toolName: 'Write',
    input: { file_path: `${NOTES}/a.md`, content: 'x' },
  })
  const fetchDocs = (toolUseId: string): PermissionCallFields => ({
    toolUseId,
    toolName: 'WebFetch',
    input: { url: 'https://docs.acme.dev/retries', prompt: 'Summarize.' },
  })

  it('stops asking about reads in a folder once it’s granted, and asks again once it’s taken back', async () => {
    const session = await startTask()
    await callTool(session, readNotes('toolu_before'))
    expect(asked()).toEqual(['toolu_before'])

    await grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })
    const granted = await callTool(session, readNotes('toolu_granted'))
    await expect(granted.answer).resolves.toEqual(ALLOWED_AT_ONCE)

    await revokeSandboxGrant(grants, taskTarget(), folderKey(NOTES))
    await callTool(session, readNotes('toolu_revoked'))
    expect(asked()).toEqual(['toolu_before', 'toolu_revoked'])
  })

  it('holds another task in the workspace to a workspace grant too, and no task elsewhere', async () => {
    const sibling = anotherTask()
    const elsewhere = anotherTask(otherWorkspace().id, 4_000)
    const second = await startTask(sibling.id)
    const third = await startTask(elsewhere.id)

    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: read(NOTES) })

    const inWorkspace = await callTool(second, readNotes('toolu_sibling'))
    await expect(inWorkspace.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    await callTool(third, readNotes('toolu_elsewhere'))
    expect(asked(sibling.id)).toEqual([])
    expect(asked(elsewhere.id)).toEqual(['toolu_elsewhere'])
  })

  it('lets a task’s Write rule write a read-write folder, and asks once it’s downgraded to read-only', async () => {
    // In the ask mode, with Write allowed for this task: Glade decides its writes against the sandbox's bounds itself.
    await glade.invoke(CommandName.TasksUpdate, {
      id: task.id,
      patch: { permissionMode: PermissionMode.AskBeforeEdits },
    })
    addTaskPermissionRule(database.db, { taskId: task.id, rule: { toolName: 'Write' } })
    const session = await startTask()
    await callTool(session, writeNotes('toolu_before'))
    expect(asked()).toEqual(['toolu_before'])

    await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite(NOTES) })
    const writable = await callTool(session, writeNotes('toolu_read_write'))
    await expect(writable.answer).resolves.toEqual(ALLOWED_AT_ONCE)

    await changeSandboxFolderAccess(grants, taskTarget(), NOTES, FolderAccess.Read)
    await callTool(session, writeNotes('toolu_read_only'))
    const stillReadable = await callTool(session, readNotes('toolu_read'))
    await expect(stillReadable.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(asked()).toEqual(['toolu_before', 'toolu_read_only'])
  })

  it('stops asking about WebFetch to a domain once it’s granted, and asks again once it’s gone', async () => {
    const session = await startTask()
    await callTool(session, fetchDocs('toolu_before'))
    expect(asked()).toEqual(['toolu_before'])

    await grantSandboxAccess(grants, { target: GLADE, grant: domain('*.acme.dev') })
    const fetched = await callTool(session, fetchDocs('toolu_granted'))
    await expect(fetched.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    // A command's connection only reaches Glade for a host Claude Code's own allowlist lacks, so it always asks: the
    // granted domain reaches commands through the overlay's rule.
    expect(session.flagSettings.at(-1)?.permissions?.allow).toEqual(['WebFetch(domain:*.acme.dev)'])

    await revokeSandboxGrant(grants, GLADE, domain('*.acme.dev'))
    await callTool(session, fetchDocs('toolu_revoked'))
    expect(asked()).toEqual(['toolu_before', 'toolu_revoked'])
  })

  it('decides against the grants at once, while the overlay is still being applied', async () => {
    const session = await startTask()
    session.onApplyFlagSettings = () => new Promise<void>(() => undefined)

    void grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })
    await settle()

    const granted = await callTool(session, readNotes('toolu_granted'))
    await expect(granted.answer).resolves.toEqual(ALLOWED_AT_ONCE)
  })
})

describe('a session that won’t take a change', () => {
  it('is closed, its turn ending on the sandbox’s error, and the caller is told; the grant stays saved', async () => {
    const session = await startTask()
    refuseOverlays(session)

    const outcome = await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite(NOTES) })

    expect(outcome).toEqual({
      change: SandboxGrantChange.Added,
      sessions: { applied: [], closed: [task.id], pending: [] },
    })
    expect(session.closed).toBe(true)
    expect(current()).toMatchObject({
      activity: TaskActivity.Error,
      error: { kind: AgentErrorKind.Permanent, source: TaskErrorSource.Sandbox, details: NOT_APPLIED },
    })
    expect(listSandboxGrants(database.db, taskTarget()).map(({ grant }) => grant)).toEqual([readWrite(NOTES)])

    // Retry starts a new session, which starts with the grant.
    await glade.invoke(CommandName.TasksRetry, { id: task.id })
    await settle()
    expect(backend.sessions).toHaveLength(2)
    expect(backend.session.flagSettings).toEqual([overlay([readWrite(NOTES)])])
  })

  it('is closed without an error between turns: the next message starts a session with the grants as saved', async () => {
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite(SHARED) })
    const session = await startTask()
    await finishTurn(session)
    refuseOverlays(session)

    const outcome = await revokeSandboxGrant(grants, workspaceTarget(), folderKey(SHARED))

    expect(outcome).toEqual({ removed: true, sessions: { applied: [], closed: [task.id], pending: [] } })
    expect(session.closed).toBe(true)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, error: null })

    runner.send(task.id, 'Carry on.')
    await settle()
    // The session that kept the folder is gone, and the new one never had it.
    expect(backend.session).not.toBe(session)
    expect(backend.session.flagSettings).toEqual([overlay([])])
    expect(backend.session.sent).toHaveLength(1)
  })

  it('leaves the other sessions the change covers running on it', async () => {
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite(SHARED) })
    const sibling = anotherTask()
    const first = await startTask(task.id)
    const second = await startTask(sibling.id)
    refuseOverlays(second)

    const outcome = await changeSandboxFolderAccess(grants, workspaceTarget(), SHARED, FolderAccess.Read)

    expect(outcome).toEqual({
      change: SandboxGrantChange.Changed,
      sessions: { applied: [task.id], closed: [sibling.id], pending: [] },
    })
    expect(first.closed).toBe(false)
    expect(first.flagSettings.at(-1)).toEqual(overlay([read(SHARED)]))
    expect(second.closed).toBe(true)
    expect(current(task.id).activity).toBe(TaskActivity.Working)
    expect(current(sibling.id)).toMatchObject({
      activity: TaskActivity.Error,
      error: { source: TaskErrorSource.Sandbox },
    })
    // A change after it reaches only the session still running.
    const later = await grantSandboxAccess(grants, { target: workspaceTarget(), grant: domain('acme.dev') })
    expect(later.sessions).toEqual({ applied: [task.id], closed: [], pending: [] })
  })
})

describe('waiting on the session that asked', () => {
  it('waits only on it, while the others apply in the background', async () => {
    const sibling = anotherTask()
    const elsewhere = anotherTask(otherWorkspace().id, 4_000)
    const asking = await startTask(task.id)
    const stuck = await startTask(sibling.id)
    const uncovered = await startTask(elsewhere.id)
    // The sibling's Claude Code never answers.
    stuck.onApplyFlagSettings = () => new Promise<void>(() => undefined)

    const outcome = await grantSandboxAccess(
      grants,
      { target: workspaceTarget(), grant: read(SHARED) },
      { awaitTaskId: task.id },
    )

    expect(outcome).toEqual({
      change: SandboxGrantChange.Added,
      sessions: { applied: [task.id], closed: [], pending: [sibling.id] },
    })
    // The stuck session was still sent the overlay; the one in the other workspace wasn't.
    expect(asking.flagSettings.at(-1)).toEqual(overlay([read(SHARED)]))
    expect(stuck.flagSettings.at(-1)).toEqual(overlay([read(SHARED)]))
    expect(uncovered.flagSettings).toEqual([overlay([], OTHER_ROOT)])
  })

  it('reports the asking session closed, and closes one that refuses in the background too', async () => {
    const sibling = anotherTask()
    const asking = await startTask(task.id)
    const other = await startTask(sibling.id)
    refuseOverlays(asking)
    refuseOverlays(other)

    const outcome = await revokeSandboxGrant(grants, workspaceTarget(), domain('acme.dev'), { awaitTaskId: task.id })
    await settle()

    expect(outcome).toEqual({ removed: false, sessions: { applied: [], closed: [task.id], pending: [sibling.id] } })
    expect(asking.closed).toBe(true)
    expect(other.closed).toBe(true)
    expect(current(sibling.id)).toMatchObject({ activity: TaskActivity.Error, error: { details: NOT_APPLIED } })
  })

  it('waits on no one when the asking task has no running session', async () => {
    const sibling = anotherTask()
    const running = await startTask(sibling.id)
    running.onApplyFlagSettings = () => new Promise<void>(() => undefined)

    const outcome = await changeSandboxFolderAccess(grants, GLADE, TOOLCHAIN, FolderAccess.Read, {
      awaitTaskId: task.id,
    })

    expect(outcome).toEqual({
      change: SandboxGrantChange.Unchanged,
      sessions: { applied: [], closed: [], pending: [sibling.id] },
    })
  })
})

describe('what a grant is checked against', () => {
  it('refuses a grant for a task or workspace that doesn’t exist', async () => {
    await expect(
      grantSandboxAccess(grants, { target: taskTarget('nothing'), grant: domain('acme.dev') }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    await expect(
      grantSandboxAccess(grants, { target: workspaceTarget('nothing'), grant: domain('acme.dev') }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    await expect(revokeSandboxGrant(grants, taskTarget('nothing'), domain('acme.dev'))).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
    await expect(
      changeSandboxFolderAccess(grants, workspaceTarget('nothing'), TOOLCHAIN, FolderAccess.Read),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
  })

  it('keeps folders absolute and tidied, and domains bare and lower case', async () => {
    await grantSandboxAccess(grants, { target: GLADE, grant: readWrite(`${TOOLCHAIN}/`) })
    await grantSandboxAccess(grants, { target: GLADE, grant: read(`${HOME}/other/../.toolchain`) })
    await grantSandboxAccess(grants, { target: GLADE, grant: domain('  Registry.NPMJS.org ') })
    await grantSandboxAccess(grants, { target: GLADE, grant: domain('*.acme.dev') })
    await grantSandboxAccess(grants, { target: GLADE, grant: read(`${HOME}/My Notes/naïve`) })

    expect(listSandboxGrants(database.db, GLADE).map(({ grant }) => grant)).toEqual([
      readWrite(TOOLCHAIN),
      domain('registry.npmjs.org'),
      domain('*.acme.dev'),
      read(`${HOME}/My Notes/naïve`),
    ])

    expect(await revokeSandboxGrant(grants, GLADE, folderKey(`${TOOLCHAIN}/`))).toMatchObject({ removed: true })
    expect(await revokeSandboxGrant(grants, GLADE, domain('REGISTRY.npmjs.org'))).toMatchObject({ removed: true })
  })

  it.each(['notes', '~/notes', './notes', ''])('refuses the relative folder %j', (path) => {
    expect(refusalOf(() => grantedFolder(path))).toMatch(/absolute/)
  })

  it.each(['/', '//', '/Users/..', `${HOME}/../../../../../../../..`])(
    'refuses %j as a folder: it’s the whole disk',
    (path) => {
      expect(refusalOf(() => grantedFolder(path))).toMatch(/disk/)
    },
  )

  it.each([
    `${HOME}/*`,
    `${HOME}/**`,
    `${HOME}/**/notes`,
    `${HOME}/note?`,
    `${HOME}/[ab]`,
    `${HOME}/notes]`,
    `${HOME}/{notes,docs}`,
    `${HOME}/notes}`,
    `${HOME}/no\\tes`,
    '/*',
  ])('refuses the pattern %j as a folder: a grant is one folder', (path) => {
    expect(refusalOf(() => grantedFolder(path))).toMatch(/pattern/)
  })

  const KEPT_DOMAINS = [
    ['registry.npmjs.org', 'registry.npmjs.org'],
    ['localhost', 'localhost'],
    ['  Registry.NPMJS.org ', 'registry.npmjs.org'],
    ['*.acme.dev', '*.acme.dev'],
    ['*.API.acme.dev', '*.api.acme.dev'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['10.0.0.1', '10.0.0.1'],
  ] as const

  it.each(KEPT_DOMAINS)('keeps the domain %j as %j', (written, kept) => {
    expect(grantedDomain(written)).toBe(kept)
  })

  it.each([
    '',
    '   ',
    '*',
    '**',
    '*.',
    '*.com',
    '*.*',
    '*.*.acme.dev',
    '**.acme.dev',
    'a*b',
    'a*b.acme.dev',
    'acme.*',
    'acme.*.dev',
    '*acme.dev',
    'acme..dev',
    'acme.dev.',
    '.acme.dev',
    '*..dev',
    '-acme.dev',
    'acme-.dev',
    'acme_api.dev',
    'https://acme.dev',
    'acme.dev/docs',
    'acme.dev:443',
    'acme dev',
    'sam@acme.dev',
  ])('refuses %j as a domain', (written) => {
    expect(refusalOf(() => grantedDomain(written))).toMatch(/domain/)
  })

  it('keeps only what the sandbox’s settings take: nothing saved is left out of a session', () => {
    const folders = [`${TOOLCHAIN}/`, `${HOME}/other/../.toolchain`, `${HOME}/My Notes/naïve`, '/opt/tools', '/tmp/x']
    const kept = {
      folders: folders.map((path) => ({ path: grantedFolder(path), access: FolderAccess.ReadWrite })),
      domains: KEPT_DOMAINS.map(([written]) => grantedDomain(written)),
    }

    const { grants: usable, rejected } = usableGrants(kept)

    expect(rejected).toEqual([])
    // The sandbox lists each as it's kept: neither side spells a folder differently from the other.
    expect(usable).toEqual(kept)
  })

  it('saves nothing for a grant it refuses, and reaches no session', async () => {
    const session = await startTask()
    const refusals = [
      grantSandboxAccess(grants, { target: GLADE, grant: read('notes') }),
      grantSandboxAccess(grants, { target: GLADE, grant: readWrite(`${HOME}/*`) }),
      grantSandboxAccess(grants, { target: GLADE, grant: readWrite('/') }),
      grantSandboxAccess(grants, { target: GLADE, grant: domain('*.com') }),
      changeSandboxFolderAccess(grants, GLADE, 'notes', FolderAccess.Read),
      revokeSandboxGrant(grants, GLADE, domain('https://acme.dev')),
      revokeSandboxGrant(grants, GLADE, folderKey(`${HOME}/[ab]`)),
    ]

    for (const refusal of refusals) {
      await expect(refusal).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    }
    expect(listSandboxGrants(database.db, GLADE)).toEqual([])
    expect(session.flagSettings).toHaveLength(1)
  })
})

describe('one folder, however it’s spelt', () => {
  let scratch: string
  /** A real folder, by its real path. */
  let real: string
  /** A symlink to `real`'s parent: another spelling of every folder under it, as `/tmp` is of `/private/tmp`. */
  let link: string

  beforeEach(() => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'glade-grants-')))
    mkdirSync(join(scratch, 'disk', 'Shared Notes'), { recursive: true })
    real = join(scratch, 'disk', 'Shared Notes')
    link = join(scratch, 'link')
    symlinkSync(join(scratch, 'disk'), link)
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const kept = (): Grant[] => listSandboxGrants(database.db, GLADE).map(({ grant }) => grant)

  it('keeps a folder granted through a symlink by its real path, and never twice', async () => {
    const throughLink = join(link, 'Shared Notes')

    const first = await grantSandboxAccess(grants, { target: GLADE, grant: read(throughLink) })
    const second = await grantSandboxAccess(grants, { target: GLADE, grant: read(real) })
    const third = await grantSandboxAccess(grants, {
      target: GLADE,
      grant: readWrite(`${throughLink}/../Shared Notes/`),
    })
    const fourth = await grantSandboxAccess(grants, { target: GLADE, grant: read(`/System/Volumes/Data${real}`) })

    expect(first.change).toBe(SandboxGrantChange.Added)
    expect(second.change).toBe(SandboxGrantChange.Unchanged)
    expect(third.change).toBe(SandboxGrantChange.Changed)
    expect(fourth.change).toBe(SandboxGrantChange.Unchanged)
    expect(kept()).toEqual([readWrite(real)])
  })

  it('revokes and downgrades a folder under either spelling, leaving it granted under neither', async () => {
    const throughLink = join(link, 'Shared Notes')
    const session = await startTask()
    await grantSandboxAccess(grants, { target: GLADE, grant: readWrite(real) })

    expect(await changeSandboxFolderAccess(grants, GLADE, throughLink, FolderAccess.Read)).toMatchObject({
      change: SandboxGrantChange.Changed,
    })
    expect(kept()).toEqual([read(real)])
    expect(session.flagSettings.at(-1)).toEqual(overlay([read(real)]))

    expect(await revokeSandboxGrant(grants, GLADE, folderKey(throughLink))).toMatchObject({ removed: true })
    expect(kept()).toEqual([])
    expect(session.flagSettings.at(-1)).toEqual(overlay([]))
  })

  it.runIf(CASE_INSENSITIVE_DISK)(
    'keeps a folder spelt in another case as the one grant, in the disk’s case',
    async () => {
      await grantSandboxAccess(grants, { target: GLADE, grant: read(join(scratch, 'DISK', 'shared notes')) })
      await grantSandboxAccess(grants, { target: GLADE, grant: read(real) })
      expect(kept()).toEqual([read(real)])

      expect(await revokeSandboxGrant(grants, GLADE, folderKey(join(scratch, 'disk', 'SHARED NOTES')))).toMatchObject({
        removed: true,
      })
      expect(kept()).toEqual([])
    },
  )

  it('keeps a folder that doesn’t exist by its nearest real folder, the rest as written', async () => {
    await grantSandboxAccess(grants, { target: GLADE, grant: read(`${join(link, 'Not', 'Made')}/../Made/Yet/`) })

    expect(kept()).toEqual([read(join(scratch, 'disk', 'Not', 'Made', 'Yet'))])
  })

  it('keeps a folder granted before it existed as the same grant once it does', async () => {
    const written = join(link, 'later')
    const made = join(scratch, 'disk', 'later')
    await grantSandboxAccess(grants, { target: GLADE, grant: read(written) })
    expect(kept()).toEqual([read(made)])
    mkdirSync(made)

    // Granted again, under either spelling, now it's there: the same grant, upgraded.
    expect(await grantSandboxAccess(grants, { target: GLADE, grant: read(made) })).toMatchObject({
      change: SandboxGrantChange.Unchanged,
    })
    expect(await grantSandboxAccess(grants, { target: GLADE, grant: readWrite(written) })).toMatchObject({
      change: SandboxGrantChange.Changed,
    })
    expect(kept()).toEqual([readWrite(made)])
    expect(await revokeSandboxGrant(grants, GLADE, folderKey(written))).toMatchObject({ removed: true })
    expect(kept()).toEqual([])
  })

  it('keeps a grant to the path it was given for when its folder is replaced by a link, and still finds it by that', async () => {
    const moved = join(scratch, 'disk', 'moved')
    const granted = join(scratch, 'granted')
    mkdirSync(moved)
    // Granted before it was there, then made as a link to somewhere else: kept as written.
    await grantSandboxAccess(grants, { target: GLADE, grant: readWrite(granted) })
    symlinkSync(moved, granted)

    // Where the link leads was never granted (#510's review: it was taken for the same folder, and so opened).
    expect(await grantSandboxAccess(grants, { target: GLADE, grant: read(moved) })).toMatchObject({
      change: SandboxGrantChange.Added,
    })
    expect(kept()).toEqual([readWrite(granted), read(moved)])
    // Each is changed by its own name, and the one that was granted is still taken back by it.
    expect(await changeSandboxFolderAccess(grants, GLADE, granted, FolderAccess.Read)).toMatchObject({
      change: SandboxGrantChange.Changed,
    })
    expect(kept()).toEqual([read(granted), read(moved)])
    expect(await revokeSandboxGrant(grants, GLADE, folderKey(granted))).toMatchObject({ removed: true })
    expect(kept()).toEqual([read(moved)])
    // With nothing kept by the link's name any more, it's another way to where it leads.
    expect(await revokeSandboxGrant(grants, GLADE, folderKey(granted))).toMatchObject({ removed: true })
    expect(kept()).toEqual([])
  })

  it('keeps a path that can’t be resolved, a loop of links, as written', async () => {
    symlinkSync(join(scratch, 'b'), join(scratch, 'a'))
    symlinkSync(join(scratch, 'a'), join(scratch, 'b'))

    await grantSandboxAccess(grants, { target: GLADE, grant: read(join(scratch, 'a', 'notes')) })

    expect(kept()).toEqual([read(join(scratch, 'a', 'notes'))])
    expect(await revokeSandboxGrant(grants, GLADE, folderKey(join(scratch, 'a', 'notes')))).toMatchObject({
      removed: true,
    })
  })

  it('refuses a symlink to a folder whose real name is a pattern', () => {
    mkdirSync(join(scratch, 'disk', '[drafts]'))
    symlinkSync(join(scratch, 'disk', '[drafts]'), join(scratch, 'drafts'))

    expect(() => grantedFolder(join(scratch, 'drafts'))).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.InvalidRequest }),
    )
  })

  it('refuses a symlink to the whole disk', () => {
    symlinkSync('/', join(scratch, 'everything'))

    expect(refusalOf(() => grantedFolder(join(scratch, 'everything')))).toMatch(/disk/)
  })
})

describe('what a task’s session reads', () => {
  it('is every scope’s grants that cover the task, as the sandbox takes them', () => {
    const elsewhere = anotherTask(otherWorkspace().id, 4_000)
    addSandboxGrant(database.db, { target: GLADE, grant: read(TOOLCHAIN) }, 10)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite(TOOLCHAIN) }, 11)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: domain('registry.npmjs.org') }, 12)
    addSandboxGrant(database.db, { target: taskTarget(), grant: read(NOTES) }, 13)
    addSandboxGrant(database.db, { target: taskTarget(elsewhere.id), grant: domain('web.dev') }, 14)

    addSandboxGrant(database.db, { target: GLADE, grant: server('claude_ai_Acme_Docs', 'claude.ai Acme Docs') }, 15)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: server('acme-tracker') }, 16)
    addSandboxGrant(database.db, { target: taskTarget(), grant: agents(OtherAgents.Cloud) }, 17)
    addSandboxGrant(database.db, { target: taskTarget(elsewhere.id), grant: agents(OtherAgents.Sessions) }, 18)

    expect(taskSandboxGrants(database.db, task)).toEqual({
      folders: [
        { path: TOOLCHAIN, access: FolderAccess.ReadWrite },
        { path: NOTES, access: FolderAccess.Read },
      ],
      domains: ['registry.npmjs.org'],
      servers: ['claude_ai_Acme_Docs', 'acme-tracker'],
      agents: [OtherAgents.Cloud],
    })
    expect(taskSandboxGrants(database.db, elsewhere)).toEqual({
      folders: [{ path: TOOLCHAIN, access: FolderAccess.Read }],
      domains: ['web.dev'],
      servers: ['claude_ai_Acme_Docs'],
      agents: [OtherAgents.Sessions],
    })
    expect(sandboxGrantsOf([])).toEqual(NO_GRANTS)
  })
})

describe('a permission card’s grant', () => {
  let scratch: string

  beforeEach(() => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'glade-card-')))
    mkdirSync(join(scratch, 'disk', 'cache'), { recursive: true })
    mkdirSync(join(scratch, 'Documents'))
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const kept = (): Grant[] => listSandboxGrants(database.db, taskTarget()).map(({ grant }) => grant)

  it('is saved as the card showed it, and never resolved again', () => {
    const cache = join(scratch, 'disk', 'cache')
    expect(hasMoved(cache)).toBe(false)
    // Swapped for a link since the card opened: whoever answers the card refuses it (`hasMoved`). And even saved, it's
    // the path the card showed that is kept, never where it leads now.
    renameSync(cache, `${cache}.was`)
    symlinkSync(join(scratch, 'Documents'), cache)
    expect(hasMoved(cache)).toBe(true)

    expect(saveCardGrant(database.db, { target: taskTarget(), grant: readWrite(cache) })).toBe(SandboxGrantChange.Added)
    expect(kept()).toEqual([readWrite(cache)])
    // `saveSandboxGrant`, for a folder added in Settings, keeps it by where it is now instead.
    saveSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite(cache) })
    expect(listSandboxGrants(database.db, workspaceTarget()).map(({ grant }) => grant)).toEqual([
      readWrite(join(scratch, 'Documents')),
    ])
  })

  it('says a folder has moved when it, or a folder above it, is now a link, or can’t be resolved', () => {
    const cache = join(scratch, 'disk', 'cache')
    expect(hasMoved(join(cache, 'not', 'made', 'yet'))).toBe(false)
    expect(hasMoved(join(scratch, 'link', 'cache'))).toBe(false)
    symlinkSync(join(scratch, 'disk'), join(scratch, 'link'))
    expect(hasMoved(join(scratch, 'link', 'cache'))).toBe(true)
    symlinkSync(join(scratch, 'b'), join(scratch, 'a'))
    symlinkSync(join(scratch, 'a'), join(scratch, 'b'))
    expect(hasMoved(join(scratch, 'a'))).toBe(true)
    // Written another way than it's kept, it isn't the path a card would show.
    expect(hasMoved(`${cache}/`)).toBe(true)
  })

  it('upgrades the folder it already has, keeps a domain lower-case, and refuses what the sandbox can’t take', () => {
    const cache = join(scratch, 'disk', 'cache')
    saveCardGrant(database.db, { target: taskTarget(), grant: read(cache) })
    expect(saveCardGrant(database.db, { target: taskTarget(), grant: read(cache) })).toBe(SandboxGrantChange.Unchanged)
    expect(saveCardGrant(database.db, { target: taskTarget(), grant: readWrite(cache) })).toBe(
      SandboxGrantChange.Changed,
    )
    expect(saveCardGrant(database.db, { target: taskTarget(), grant: domain('Registry.NPMjs.org') })).toBe(
      SandboxGrantChange.Added,
    )
    expect(kept()).toEqual([readWrite(cache), domain('registry.npmjs.org')])

    expect(refusalOf(() => saveCardGrant(database.db, { target: taskTarget(), grant: read('/') }))).toMatch(/disk/)
    expect(refusalOf(() => saveCardGrant(database.db, { target: taskTarget(), grant: read(`${scratch}/*`) }))).toMatch(
      /pattern/,
    )
    expect(() => saveCardGrant(database.db, { target: taskTarget('no-such-task'), grant: read(cache) })).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.NotFound }),
    )
  })

  it('keeps a single file a single file: to the sandbox, and to whoever asks which grant gives a path', async () => {
    const gitconfig = join(scratch, '.gitconfig')
    const file: Grant = { kind: SandboxGrantKind.Folder, path: gitconfig, access: FolderAccess.Read, file: true }
    saveCardGrant(database.db, { target: taskTarget(), grant: file })
    await grantSandboxAccess(grants, { target: GLADE, grant: readWrite(join(scratch, 'disk')) })

    expect(kept()).toEqual([file])
    expect(taskSandboxGrants(database.db, task)).toEqual({
      folders: [
        { path: gitconfig, access: FolderAccess.Read, file: true },
        { path: join(scratch, 'disk'), access: FolderAccess.ReadWrite },
      ],
      domains: [],
      servers: [],
      agents: [],
    })
    const held = heldGrants(database.db, task)
    expect(held).toEqual([
      { scope: SandboxGrantScope.Task, grant: file },
      { scope: SandboxGrantScope.Glade, grant: readWrite(join(scratch, 'disk')) },
    ])
    const gives = (path: string, access = FolderAccess.Read): SandboxGrantScope | null =>
      grantingGrant(held, { kind: SandboxGrantKind.Folder, key: pathKey(path), access })?.scope ?? null
    // The file's grant gives that path, and nothing that only starts like it or is beside it.
    expect(gives(gitconfig)).toBe(SandboxGrantScope.Task)
    expect(gives(gitconfig, FolderAccess.ReadWrite)).toBeNull()
    expect(gives(`${gitconfig}.bak`)).toBeNull()
    expect(gives(join(gitconfig, 'inside'))).toBeNull()
    expect(gives(join(scratch, '.zshrc'))).toBeNull()
    expect(gives(scratch)).toBeNull()
    // A folder's gives everything in it.
    expect(gives(join(scratch, 'disk', 'cache', 'a.json'), FolderAccess.ReadWrite)).toBe(SandboxGrantScope.Glade)
  })

  it('says whose grant gives a path by the grant as kept, never by where its folder leads now', async () => {
    const cache = join(scratch, 'disk', 'cache')
    await grantSandboxAccess(grants, { target: taskTarget(), grant: read(cache) })
    renameSync(cache, `${cache}.was`)
    symlinkSync(join(scratch, 'Documents'), cache)

    const held = heldGrants(database.db, task)
    const gives = (path: string): boolean =>
      grantingGrant(held, { kind: SandboxGrantKind.Folder, key: pathKey(path), access: FolderAccess.Read }) !== null
    // Before #510's review, the grant was taken for the folder its link now leads to.
    expect(gives(join(scratch, 'Documents', 'taxes.txt'))).toBe(false)
    expect(gives(join(cache, 'index.json'))).toBe(true)
  })
})

describe('grants going with what they belong to', () => {
  it('deletes a task’s grants with the task, and keeps the workspace’s and Glade’s', async () => {
    const sibling = anotherTask()
    await grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })
    await grantSandboxAccess(grants, { target: taskTarget(sibling.id), grant: domain('acme.dev') })
    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: domain('registry.npmjs.org') })
    await grantSandboxAccess(grants, { target: GLADE, grant: read(TOOLCHAIN) })
    const session = await startTask()

    await glade.invoke(CommandName.TasksDelete, { id: task.id })

    expect(listSandboxGrants(database.db, taskTarget())).toEqual([])
    expect(listSandboxGrants(database.db, taskTarget(sibling.id))).toHaveLength(1)
    expect(listSandboxGrants(database.db, workspaceTarget())).toHaveLength(1)
    expect(listSandboxGrants(database.db, GLADE)).toHaveLength(1)
    // The deleted task's session is gone: a later grant reaches no one.
    const later = await grantSandboxAccess(grants, { target: GLADE, grant: domain('acme.dev') })
    expect(later.sessions).toEqual(NOTHING)
    expect(session.flagSettings).toHaveLength(1)
  })

  it('deletes a workspace’s grants, and its tasks’, when it’s removed, and keeps Glade’s and other workspaces’', async () => {
    const web = otherWorkspace()
    const webTask = anotherTask(web.id)
    await grantSandboxAccess(grants, { target: taskTarget(), grant: read(NOTES) })
    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: domain('registry.npmjs.org') })
    await grantSandboxAccess(grants, { target: workspaceTarget(web.id), grant: domain('web.dev') })
    await grantSandboxAccess(grants, { target: taskTarget(webTask.id), grant: domain('cdn.web.dev') })
    await grantSandboxAccess(grants, { target: GLADE, grant: read(TOOLCHAIN) })

    await glade.invoke(CommandName.WorkspacesRemove, { id: workspace.id })

    expect(listSandboxGrants(database.db, taskTarget())).toEqual([])
    expect(listSandboxGrants(database.db, workspaceTarget())).toEqual([])
    expect(listSandboxGrants(database.db, workspaceTarget(web.id))).toHaveLength(1)
    expect(listSandboxGrants(database.db, taskTarget(webTask.id))).toHaveLength(1)
    expect(listSandboxGrants(database.db, GLADE)).toHaveLength(1)
  })
})

describe('a card’s grant', () => {
  it('is saved without telling any session, for whoever answered the card to apply', async () => {
    const session = await startTask()
    const overlays = session.flagSettings.length
    const target: SandboxGrantTarget = { scope: SandboxGrantScope.Task, taskId: task.id }

    expect(saveSandboxGrant(database.db, { target, grant: read(`${NOTES}/`) })).toBe(SandboxGrantChange.Added)
    expect(saveSandboxGrant(database.db, { target, grant: read(NOTES) })).toBe(SandboxGrantChange.Unchanged)
    expect(saveSandboxGrant(database.db, { target, grant: readWrite(NOTES) })).toBe(SandboxGrantChange.Changed)
    expect(saveSandboxGrant(database.db, { target, grant: domain('Registry.NPMjs.org') })).toBe(
      SandboxGrantChange.Added,
    )

    expect(listSandboxGrants(database.db, target).map(({ grant }) => grant)).toEqual([
      readWrite(NOTES),
      domain('registry.npmjs.org'),
    ])
    expect(session.flagSettings).toHaveLength(overlays)
    expect(() => saveSandboxGrant(database.db, { target, grant: read('/') })).toThrow(CommandFailure)
    expect(() =>
      saveSandboxGrant(database.db, {
        target: { scope: SandboxGrantScope.Task, taskId: 'gone' },
        grant: read(NOTES),
      }),
    ).toThrow(CommandFailure)
  })

  it('says whose grant gives a task a folder or a domain: the narrowest scope that does', () => {
    const other = anotherTask()
    const workspaceTarget: SandboxGrantTarget = { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id }
    saveSandboxGrant(database.db, { target: GLADE, grant: read(TOOLCHAIN) })
    saveSandboxGrant(database.db, { target: GLADE, grant: domain('*.acme.dev') })
    saveSandboxGrant(database.db, { target: workspaceTarget, grant: read(SHARED) })
    saveSandboxGrant(database.db, { target: workspaceTarget, grant: readWrite(DOCS) })
    saveSandboxGrant(database.db, {
      target: { scope: SandboxGrantScope.Task, taskId: task.id },
      grant: readWrite(SHARED),
    })

    const scope = (grant: Grant, of = task): SandboxGrantScope | null => {
      const use: GrantedUse =
        grant.kind === SandboxGrantKind.Folder
          ? { kind: grant.kind, key: pathKey(grant.path), access: grant.access }
          : grant
      return grantingGrant(heldGrants(database.db, of), use)?.scope ?? null
    }
    // A file inside a granted folder is covered by it; a wider access than granted isn't.
    expect(scope(read(`${TOOLCHAIN}/bin/node`))).toBe(SandboxGrantScope.Glade)
    expect(scope(readWrite(TOOLCHAIN))).toBeNull()
    expect(scope(read(`${DOCS}/guide.md`))).toBe(SandboxGrantScope.Workspace)
    expect(scope(readWrite(DOCS))).toBe(SandboxGrantScope.Workspace)
    // The task's own grant comes before the workspace's, and is no other task's.
    expect(scope(read(SHARED))).toBe(SandboxGrantScope.Task)
    expect(scope(readWrite(SHARED))).toBe(SandboxGrantScope.Task)
    expect(scope(read(SHARED), other)).toBe(SandboxGrantScope.Workspace)
    expect(scope(readWrite(SHARED), other)).toBeNull()
    expect(scope(read(NOTES))).toBeNull()
    expect(scope(domain('docs.acme.dev'))).toBe(SandboxGrantScope.Glade)
    expect(scope(domain('registry.npmjs.org'))).toBeNull()
    // A folder isn't a domain, whatever its name.
    expect(scope(domain(TOOLCHAIN))).toBeNull()
  })
})
