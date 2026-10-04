// The sandbox lists in Settings (P15-06, #451), through the real bridge: the `sandbox.*` commands a window sends, the
// grants' store behind them, the `sandbox.grantsChanged` broadcasts, and fake agent sessions that take each change
// without restarting. The home folder is a temporary one, so the paths the sandbox resolves are never the machine's.
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  EventType,
  type GladeBridge,
  type GladeEvent,
  type SandboxGrantsChangedEvent,
} from '../../shared/bridge'
import {
  Effort,
  PermissionDecisionKind,
  PermissionMode,
  PermissionRequestState,
  TaskActivity,
  UiStateKey,
  type Task,
  type Workspace,
} from '../../shared/domain'
import {
  FolderAccess,
  SandboxGrantKind,
  SandboxGrantScope,
  SETTINGS_GRANT_REFUSALS,
  type Grant,
  type SettingsGrantTarget,
} from '../../shared/sandbox'
import { ToolPermissionBehavior, type SandboxFlagSettings } from '../agent/backend'
import { FakeAgentBackend, settle, type FakeAgentSession } from '../agent/fake-backend'
import type { AgentRunner } from '../agent/runner'
import { sandboxOverlay } from '../agent/sandbox'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge } from '../bridge'
import type { Emit } from '../bridge/events'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { listSandboxGrants } from '../db/repositories/sandbox-grants'
import { updateSettings } from '../db/repositories/settings'
import { createTask, getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { createWorkspace } from '../db/repositories/workspaces'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { grantSandboxAccess, sandboxGrantsOf } from './grants'

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

const GLADE: SettingsGrantTarget = { scope: SandboxGrantScope.Glade }

const HOME = homedir()
const ROOT = `${HOME}/src/acme-api`
const OTHER_ROOT = `${HOME}/src/acme-web`
/** Folders under the home folder, which nothing may use until they're granted. None exists. */
const TOOLCHAIN = `${HOME}/.toolchain`
const SHARED = `${HOME}/shared`
const NOTES = `${HOME}/notes`

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let runner: AgentRunner
let emit: Emit
let glade: GladeBridge
let log: MemoryLog
let events: GladeEvent[]

const workspaceTarget = (id = workspace.id): SettingsGrantTarget => ({
  scope: SandboxGrantScope.Workspace,
  workspaceId: id,
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  database = openTestDatabase()
  // The sandbox is off by default until P15's last PR: the tests here turn it on, but the one that says otherwise.
  updateSettings(database.db, { sandboxEnabled: true })
  workspace = sampleWorkspace(database.db, ROOT)
  task = sampleTask(database.db, workspace.id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
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
  events = []
  glade.subscribe((event) => events.push(event))
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

/** The broadcasts of the lists Settings shows, since the last call. */
function broadcasts(): SandboxGrantsChangedEvent[] {
  const found = events.filter((event) => event.type === EventType.SandboxGrantsChanged)
  events = []
  return found
}

/** A scope's grants as saved. */
function saved(target: SettingsGrantTarget): Grant[] {
  return listSandboxGrants(database.db, target).map(({ grant }) => grant)
}

function list(target: SettingsGrantTarget): Promise<readonly Grant[]> {
  return glade.invoke(CommandName.SandboxListGrants, { target }).then(({ grants }) => grants)
}

function add(target: SettingsGrantTarget, grant: Grant): Promise<readonly Grant[]> {
  return glade.invoke(CommandName.SandboxAddGrant, { target, grant }).then(({ grants }) => grants)
}

/** What Add… is refused with: an `invalid_request` whose message is the command, then the reason Settings shows. */
function refusal(reason: string): unknown {
  return bridgeError(BridgeErrorCode.InvalidRequest, `${CommandName.SandboxAddGrant}: ${reason}`)
}

/** The overlay the real builder makes for a task with these grants, in its root. */
function overlay(given: readonly Grant[], root = ROOT): SandboxFlagSettings {
  return sandboxOverlay(root, PermissionMode.AllowAll, sandboxGrantsOf(given))
}

/** Sends a task a message, starting its session, and lets the session say it's started. */
async function startTask(id = task.id): Promise<FakeAgentSession> {
  runner.send(id, 'Find out why the login test is flaky.')
  const session = backend.session
  session.emit(sdk.init(`session-${id}`))
  await settle()
  return session
}

function anotherTask(workspaceId = workspace.id, now = 3_000): Task {
  return createTask(database.db, { workspaceId, model: 'claude-sample-1', effort: Effort.Medium }, now)
}

function otherWorkspace(): Workspace {
  return createWorkspace(database.db, { name: 'Acme Web', rootPath: OTHER_ROOT }, 1_000)
}

describe('listing', () => {
  it('starts with nothing granted, Glade-wide and in a workspace', async () => {
    await expect(list(GLADE)).resolves.toEqual([])
    await expect(list(workspaceTarget())).resolves.toEqual([])
    expect(broadcasts()).toEqual([])
  })

  it('lists a scope’s folders and domains in the order they were granted, and no other scope’s', async () => {
    const elsewhere = otherWorkspace()
    await add(GLADE, read(TOOLCHAIN))
    await add(workspaceTarget(), readWrite(SHARED))
    await add(GLADE, domain('pypi.org'))
    await add(workspaceTarget(elsewhere.id), domain('github.com'))
    await grantSandboxAccess(
      { db: database.db, runner, emit },
      { target: { scope: SandboxGrantScope.Task, taskId: task.id }, grant: read(NOTES) },
    )

    await expect(list(GLADE)).resolves.toEqual([read(TOOLCHAIN), domain('pypi.org')])
    await expect(list(workspaceTarget())).resolves.toEqual([readWrite(SHARED)])
    await expect(list(workspaceTarget(elsewhere.id))).resolves.toEqual([domain('github.com')])
  })

  it('refuses a workspace that doesn’t exist, for every command', async () => {
    const gone = workspaceTarget('no-such-workspace')
    const notFound = (command: CommandName): unknown =>
      bridgeError(BridgeErrorCode.NotFound, `${command}: No workspace no-such-workspace`)

    await expect(glade.invoke(CommandName.SandboxListGrants, { target: gone })).rejects.toEqual(
      notFound(CommandName.SandboxListGrants),
    )
    await expect(glade.invoke(CommandName.SandboxAddGrant, { target: gone, grant: read(SHARED) })).rejects.toEqual(
      notFound(CommandName.SandboxAddGrant),
    )
    await expect(
      glade.invoke(CommandName.SandboxSetFolderAccess, { target: gone, path: SHARED, access: FolderAccess.Read }),
    ).rejects.toEqual(notFound(CommandName.SandboxSetFolderAccess))
    await expect(
      glade.invoke(CommandName.SandboxRemoveGrant, { target: gone, grant: domain('pypi.org') }),
    ).rejects.toEqual(notFound(CommandName.SandboxRemoveGrant))
    expect(broadcasts()).toEqual([])
  })

  it('keeps many rows and a long path as they were added', async () => {
    const deep = `${HOME}/${Array.from({ length: 40 }, (_, index) => `level-${String(index)}`).join('/')}`
    const many = Array.from({ length: 120 }, (_, index) => domain(`host-${String(index)}.example.com`))
    await add(GLADE, read(deep))
    for (const grant of many) await add(GLADE, grant)

    const listed = await list(GLADE)

    expect(deep.length).toBeGreaterThan(300)
    expect(listed).toEqual([read(deep), ...many])
    expect(broadcasts().at(-1)?.grants).toEqual(listed)
  })
})

describe('adding', () => {
  it('adds a Glade-wide folder and domain, tells the windows, and reaches every running task without a restart', async () => {
    const elsewhere = anotherTask(otherWorkspace().id)
    const first = await startTask(task.id)
    const second = await startTask(elsewhere.id)
    broadcasts()

    await expect(add(GLADE, read(TOOLCHAIN))).resolves.toEqual([read(TOOLCHAIN)])
    await expect(add(GLADE, domain('pypi.org'))).resolves.toEqual([read(TOOLCHAIN), domain('pypi.org')])

    expect(saved(GLADE)).toEqual([read(TOOLCHAIN), domain('pypi.org')])
    expect(broadcasts()).toEqual([
      { type: EventType.SandboxGrantsChanged, target: GLADE, grants: [read(TOOLCHAIN)] },
      { type: EventType.SandboxGrantsChanged, target: GLADE, grants: [read(TOOLCHAIN), domain('pypi.org')] },
    ])
    expect(first.flagSettings).toEqual([
      overlay([]),
      overlay([read(TOOLCHAIN)]),
      overlay([read(TOOLCHAIN), domain('pypi.org')]),
    ])
    expect(second.flagSettings.at(-1)).toEqual(overlay([read(TOOLCHAIN), domain('pypi.org')], OTHER_ROOT))
    expect(backend.sessions).toEqual([first, second])
    expect(backend.sessions.some(({ closed }) => closed)).toBe(false)
    expect(log.withMessage('sandbox grant list changed').map(({ fields }) => fields)).toEqual([
      { scope: 'glade', workspaceId: null, grants: 1 },
      { scope: 'glade', workspaceId: null, grants: 2 },
    ])
  })

  it('adds to a workspace, read-write or read-only, reaching its running tasks alone', async () => {
    const elsewhere = anotherTask(otherWorkspace().id)
    const here = await startTask(task.id)
    const there = await startTask(elsewhere.id)
    broadcasts()

    await add(workspaceTarget(), readWrite(SHARED))
    await add(workspaceTarget(), read(NOTES))
    await expect(add(workspaceTarget(), domain('github.com'))).resolves.toEqual([
      readWrite(SHARED),
      read(NOTES),
      domain('github.com'),
    ])

    expect(broadcasts().map(({ target, grants }) => [target, grants.length])).toEqual([
      [workspaceTarget(), 1],
      [workspaceTarget(), 2],
      [workspaceTarget(), 3],
    ])
    expect(here.flagSettings.at(-1)).toEqual(overlay([readWrite(SHARED), read(NOTES), domain('github.com')]))
    expect(here.flagSettings.at(-1)?.sandbox?.filesystem).toMatchObject({
      allowRead: [ROOT, SHARED, NOTES],
      allowWrite: [ROOT, SHARED],
    })
    expect(there.flagSettings).toEqual([overlay([], OTHER_ROOT)])
    await expect(list(GLADE)).resolves.toEqual([])
  })

  it('keeps a domain lower case, and takes every host under one', async () => {
    await expect(add(GLADE, domain('  Registry.NPMJS.org '))).resolves.toEqual([domain('registry.npmjs.org')])
    await expect(add(GLADE, domain('*.Example.com'))).resolves.toEqual([
      domain('registry.npmjs.org'),
      domain('*.example.com'),
    ])
    await expect(add(GLADE, domain('localhost'))).resolves.toHaveLength(3)
  })

  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['a URL', 'https://example.com'],
    ['a host with a path', 'example.com/docs'],
    ['a host with a port', 'example.com:8080'],
    ['two words', 'example com'],
    ['a whole top-level domain', '*.com'],
    ['a wildcard in the middle', 'api.*.example.com'],
    ['a bare wildcard', '*'],
    ['an empty label', 'example..com'],
  ])('refuses %s as a domain, with why, saving and telling nothing', async (_, value) => {
    await startTask()
    broadcasts()

    await expect(add(GLADE, domain(value))).rejects.toEqual(refusal(`Can't grant "${value}": not a domain`))
    await expect(add(workspaceTarget(), domain(value))).rejects.toEqual(refusal(`Can't grant "${value}": not a domain`))

    expect(saved(GLADE)).toEqual([])
    expect(saved(workspaceTarget())).toEqual([])
    expect(broadcasts()).toEqual([])
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)
  })

  it.each([
    ['a pattern', `${HOME}/src/*`, 'a pattern, not a folder'],
    ['a bracket pattern', `${HOME}/notes[1]`, 'a pattern, not a folder'],
    ['the whole disk', '/', 'the whole disk'],
    ['a relative path', 'notes', 'not an absolute path'],
  ])('refuses %s as a folder, with why', async (_, path, why) => {
    await expect(add(GLADE, read(path))).rejects.toEqual(refusal(`Can't grant "${path}": ${why}`))
    await expect(add(workspaceTarget(), read(path))).rejects.toEqual(refusal(`Can't grant "${path}": ${why}`))

    expect(saved(GLADE)).toEqual([])
    expect(saved(workspaceTarget())).toEqual([])
    expect(broadcasts()).toEqual([])
  })

  it('refuses a duplicate folder or domain, however it’s spelt, and leaves the list as it was', async () => {
    await add(GLADE, readWrite(SHARED))
    await add(GLADE, domain('pypi.org'))
    broadcasts()

    await expect(add(GLADE, readWrite(SHARED))).rejects.toEqual(refusal(SETTINGS_GRANT_REFUSALS.duplicateFolder))
    // Read-only, when it's already read-write: adding never narrows a folder.
    await expect(add(GLADE, read(`${SHARED}/`))).rejects.toEqual(refusal(SETTINGS_GRANT_REFUSALS.duplicateFolder))
    await expect(add(GLADE, domain('PyPI.org'))).rejects.toEqual(refusal(SETTINGS_GRANT_REFUSALS.duplicateDomain))

    expect(saved(GLADE)).toEqual([readWrite(SHARED), domain('pypi.org')])
    expect(broadcasts()).toEqual([])
    // Another scope's list is its own: the same folder and domain go in a workspace's.
    await expect(add(workspaceTarget(), read(SHARED))).resolves.toEqual([read(SHARED)])
    await expect(add(workspaceTarget(), domain('pypi.org'))).resolves.toEqual([read(SHARED), domain('pypi.org')])
  })

  it('upgrades a read-only folder added again read-write, in its place', async () => {
    await add(workspaceTarget(), read(SHARED))
    await add(workspaceTarget(), domain('github.com'))
    const session = await startTask()
    broadcasts()

    await expect(add(workspaceTarget(), readWrite(SHARED))).resolves.toEqual([readWrite(SHARED), domain('github.com')])

    expect(broadcasts()).toEqual([
      {
        type: EventType.SandboxGrantsChanged,
        target: workspaceTarget(),
        grants: [readWrite(SHARED), domain('github.com')],
      },
    ])
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem).toMatchObject({ allowWrite: [ROOT, SHARED] })
  })

  it('refuses a workspace its own root, or a folder inside it, which its agents can already use', async () => {
    mkdirSync(`${ROOT}/packages/api`, { recursive: true })
    symlinkSync(ROOT, `${HOME}/api-link`)
    const target = workspaceTarget()

    await expect(add(target, read(ROOT))).rejects.toEqual(refusal(SETTINGS_GRANT_REFUSALS.workspaceRoot))
    await expect(add(target, readWrite(`${ROOT}/`))).rejects.toEqual(refusal(SETTINGS_GRANT_REFUSALS.workspaceRoot))
    // By another name: a link to the root is the root.
    await expect(add(target, read(`${HOME}/api-link`))).rejects.toEqual(refusal(SETTINGS_GRANT_REFUSALS.workspaceRoot))
    await expect(add(target, read(`${ROOT}/packages/api`))).rejects.toEqual(
      refusal(SETTINGS_GRANT_REFUSALS.insideWorkspaceRoot),
    )
    // One that doesn't exist yet is inside it all the same.
    await expect(add(target, readWrite(`${ROOT}/dist/reports`))).rejects.toEqual(
      refusal(SETTINGS_GRANT_REFUSALS.insideWorkspaceRoot),
    )
    await expect(add(target, read(`${HOME}/api-link/packages`))).rejects.toEqual(
      refusal(SETTINGS_GRANT_REFUSALS.insideWorkspaceRoot),
    )

    expect(saved(target)).toEqual([])
    expect(broadcasts()).toEqual([])
    // A folder beside the root, whose name starts as the root's does, isn't inside it; nor is the root's parent.
    await expect(add(target, read(`${ROOT}-docs`))).resolves.toEqual([read(`${ROOT}-docs`)])
    await expect(add(target, read(`${HOME}/src`))).resolves.toHaveLength(2)
  })

  it('takes a workspace’s root, or a folder inside it, Glade-wide and in another workspace: their agents can’t use it', async () => {
    const elsewhere = otherWorkspace()

    await expect(add(GLADE, read(ROOT))).resolves.toEqual([read(ROOT)])
    await expect(add(workspaceTarget(elsewhere.id), readWrite(`${ROOT}/packages`))).resolves.toEqual([
      readWrite(`${ROOT}/packages`),
    ])
  })
})

describe('changing a folder’s access', () => {
  it('narrows and widens a folder in both lists, reaching running tasks without a restart', async () => {
    await add(GLADE, readWrite(TOOLCHAIN))
    await add(workspaceTarget(), read(SHARED))
    const session = await startTask()
    broadcasts()

    await expect(
      glade.invoke(CommandName.SandboxSetFolderAccess, { target: GLADE, path: TOOLCHAIN, access: FolderAccess.Read }),
    ).resolves.toEqual({ grants: [read(TOOLCHAIN)] })
    expect(session.flagSettings.at(-1)).toEqual(overlay([read(TOOLCHAIN), read(SHARED)]))
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem).toMatchObject({ allowWrite: [ROOT] })

    await expect(
      glade.invoke(CommandName.SandboxSetFolderAccess, {
        target: workspaceTarget(),
        path: SHARED,
        access: FolderAccess.ReadWrite,
      }),
    ).resolves.toEqual({ grants: [readWrite(SHARED)] })
    expect(session.flagSettings.at(-1)).toEqual(overlay([read(TOOLCHAIN), readWrite(SHARED)]))
    expect(session.flagSettings.at(-1)?.sandbox?.filesystem).toMatchObject({ allowWrite: [ROOT, SHARED] })

    expect(broadcasts()).toEqual([
      { type: EventType.SandboxGrantsChanged, target: GLADE, grants: [read(TOOLCHAIN)] },
      { type: EventType.SandboxGrantsChanged, target: workspaceTarget(), grants: [readWrite(SHARED)] },
    ])
    expect(backend.sessions).toEqual([session])
    expect(session.closed).toBe(false)
  })

  it('changes nothing, and tells nothing, for the access a folder has or a folder the list doesn’t', async () => {
    await add(GLADE, read(TOOLCHAIN))
    broadcasts()

    await expect(
      glade.invoke(CommandName.SandboxSetFolderAccess, { target: GLADE, path: TOOLCHAIN, access: FolderAccess.Read }),
    ).resolves.toEqual({ grants: [read(TOOLCHAIN)] })
    // Removed since the list was drawn, say.
    await expect(
      glade.invoke(CommandName.SandboxSetFolderAccess, { target: GLADE, path: NOTES, access: FolderAccess.ReadWrite }),
    ).resolves.toEqual({ grants: [read(TOOLCHAIN)] })

    expect(broadcasts()).toEqual([])
  })
})

describe('removing', () => {
  it('removes a folder and a domain from each list, and the running tasks lose them', async () => {
    await add(GLADE, read(TOOLCHAIN))
    await add(GLADE, domain('pypi.org'))
    await add(workspaceTarget(), readWrite(SHARED))
    await add(workspaceTarget(), domain('github.com'))
    const session = await startTask()
    broadcasts()

    await expect(
      glade.invoke(CommandName.SandboxRemoveGrant, {
        target: GLADE,
        grant: { kind: SandboxGrantKind.Folder, path: TOOLCHAIN },
      }),
    ).resolves.toEqual({ grants: [domain('pypi.org')] })
    await expect(
      glade.invoke(CommandName.SandboxRemoveGrant, { target: workspaceTarget(), grant: domain('github.com') }),
    ).resolves.toEqual({ grants: [readWrite(SHARED)] })

    expect(session.flagSettings.at(-1)).toEqual(overlay([domain('pypi.org'), readWrite(SHARED)]))
    expect(broadcasts()).toEqual([
      { type: EventType.SandboxGrantsChanged, target: GLADE, grants: [domain('pypi.org')] },
      { type: EventType.SandboxGrantsChanged, target: workspaceTarget(), grants: [readWrite(SHARED)] },
    ])
    expect(session.closed).toBe(false)
  })

  it('changes nothing, and tells nothing, for a grant the list doesn’t have: removed twice, say', async () => {
    await add(GLADE, domain('pypi.org'))
    broadcasts()
    const remove = (): Promise<unknown> =>
      glade.invoke(CommandName.SandboxRemoveGrant, { target: GLADE, grant: domain('pypi.org') })

    await expect(remove()).resolves.toEqual({ grants: [] })
    await expect(remove()).resolves.toEqual({ grants: [] })

    expect(broadcasts()).toEqual([{ type: EventType.SandboxGrantsChanged, target: GLADE, grants: [] }])
  })

  it('removes a grant while a card about its folder is open: the card stays, and is answered as before', async () => {
    updateSettings(database.db, { defaultPermissionMode: PermissionMode.AllowAll })
    await add(workspaceTarget(), read(NOTES))
    const session = await startTask()
    // The folder is read-only, so a write to it asks.
    const call = { toolUseId: 'toolu_write', toolName: 'Write', input: { file_path: `${NOTES}/a.md`, content: 'x' } }
    session.emit(sdk.toolUse(call.toolUseId, call.toolName, { ...call.input }))
    await settle()
    const asked = session.requestPermission(call)
    await settle()
    const [open] = listPermissionRequests(database.db, task.id)
    expect(open?.state).toBe(PermissionRequestState.Open)
    broadcasts()

    await expect(
      glade.invoke(CommandName.SandboxRemoveGrant, {
        target: workspaceTarget(),
        grant: { kind: SandboxGrantKind.Folder, path: NOTES },
      }),
    ).resolves.toEqual({ grants: [] })

    expect(broadcasts()).toEqual([{ type: EventType.SandboxGrantsChanged, target: workspaceTarget(), grants: [] }])
    expect(session.flagSettings.at(-1)).toEqual(overlay([]))
    expect(session.closed).toBe(false)
    expect(listPermissionRequests(database.db, task.id).map(({ state }) => state)).toEqual([
      PermissionRequestState.Open,
    ])
    // The card is the folder's (#450): allowed for the task, it grants the task alone, and the workspace's list stays.
    await glade.invoke(CommandName.PermissionsAnswer, {
      id: open?.id ?? '',
      decision: { kind: PermissionDecisionKind.AllowForTask },
    })
    await expect(asked.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Allow })
    await expect(list(workspaceTarget())).resolves.toEqual([])
  })
})

describe('what the sessions make of a change', () => {
  it('lists the grant as saved even when a session won’t take it and is closed', async () => {
    const session = await startTask()
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings_not_applied'))

    await expect(add(workspaceTarget(), read(SHARED))).resolves.toEqual([read(SHARED)])

    expect(session.closed).toBe(true)
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Error)
    await expect(list(workspaceTarget())).resolves.toEqual([read(SHARED)])
    // Its next session starts with the grant.
    session.onApplyFlagSettings = () => Promise.resolve()
  })

  it('saves and lists grants while the sandbox is off: no session takes them until it’s back on', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    const unsandboxed = await startTask()

    await expect(add(GLADE, read(TOOLCHAIN))).resolves.toEqual([read(TOOLCHAIN)])

    expect(unsandboxed.options.flagSettings).toBeUndefined()
    expect(unsandboxed.flagSettings).toEqual([])
    expect(broadcasts().filter(({ target }) => target.scope === SandboxGrantScope.Glade)).toHaveLength(1)
    // On again, a new task's session starts in the sandbox, with the grant.
    updateSettings(database.db, { sandboxEnabled: true })
    const sandboxed = await startTask(anotherTask().id)
    expect(sandboxed.flagSettings).toEqual([overlay([read(TOOLCHAIN)])])
  })

  it('tells the windows of a workspace grant made outside Settings, as a card’s is, and of no task’s', async () => {
    const context = { db: database.db, runner, emit }

    await grantSandboxAccess(context, { target: workspaceTarget(), grant: readWrite(SHARED) })
    await grantSandboxAccess(context, {
      target: { scope: SandboxGrantScope.Task, taskId: task.id },
      grant: read(NOTES),
    })

    expect(broadcasts()).toEqual([
      { type: EventType.SandboxGrantsChanged, target: workspaceTarget(), grants: [readWrite(SHARED)] },
    ])
  })
})

describe('a bad payload', () => {
  /** Sends a request the types wouldn't allow, as a compromised or buggy window could. */
  const send = (command: CommandName, request: unknown): Promise<unknown> => glade.invoke(command, request as never)

  it.each([
    [
      'a task’s scope',
      CommandName.SandboxListGrants,
      { target: { scope: 'task', taskId: 'task-1' } },
      /^sandbox\.listGrants: target\.scope: Invalid discriminator value/,
    ],
    ['no scope', CommandName.SandboxListGrants, {}, /^sandbox\.listGrants: target: Invalid input/],
    [
      'a workspace scope with no workspace',
      CommandName.SandboxListGrants,
      { target: { scope: 'workspace' } },
      /^sandbox\.listGrants: target\.workspaceId: Invalid input: expected string, received undefined$/,
    ],
    [
      'a folder with no access',
      CommandName.SandboxAddGrant,
      { target: { scope: 'glade' }, grant: { kind: 'folder', path: '/Users/sam/notes' } },
      /^sandbox\.addGrant: grant\.access: Invalid option/,
    ],
    [
      'an access the sandbox doesn’t have',
      CommandName.SandboxAddGrant,
      { target: { scope: 'glade' }, grant: { kind: 'folder', path: '/Users/sam/notes', access: 'execute' } },
      /^sandbox\.addGrant: grant\.access: Invalid option/,
    ],
    [
      'a grant of no kind',
      CommandName.SandboxAddGrant,
      { target: { scope: 'glade' }, grant: { kind: 'socket', path: '/tmp/x' } },
      /^sandbox\.addGrant: grant\.kind: Invalid discriminator value/,
    ],
    [
      'a domain that isn’t text',
      CommandName.SandboxAddGrant,
      { target: { scope: 'glade' }, grant: { kind: 'domain', domain: ['pypi.org'] } },
      /^sandbox\.addGrant: grant\.domain: Invalid input: expected string, received array$/,
    ],
    [
      'a field it doesn’t know',
      CommandName.SandboxAddGrant,
      { target: { scope: 'glade', everywhere: true }, grant: { kind: 'domain', domain: 'pypi.org' } },
      /^sandbox\.addGrant: target: Unrecognized key: "everywhere"$/,
    ],
    [
      'an access change with no path',
      CommandName.SandboxSetFolderAccess,
      { target: { scope: 'glade' }, access: 'read' },
      /^sandbox\.setFolderAccess: path: Invalid input: expected string, received undefined$/,
    ],
    [
      'a removal of nothing',
      CommandName.SandboxRemoveGrant,
      { target: { scope: 'glade' } },
      /^sandbox\.removeGrant: grant: Invalid input/,
    ],
    ['no request at all', CommandName.SandboxRemoveGrant, null, /^sandbox\.removeGrant: /],
  ])('answers %s with a bridge error, changing nothing', async (_, command, request, message) => {
    await add(GLADE, domain('pypi.org'))
    const session = await startTask()
    broadcasts()

    await expect(send(command, request)).rejects.toMatchObject({
      name: 'BridgeError',
      code: BridgeErrorCode.InvalidRequest,
      message: expect.stringMatching(message) as unknown,
    })

    expect(saved(GLADE)).toEqual([domain('pypi.org')])
    expect(broadcasts()).toEqual([])
    expect(session.flagSettings).toHaveLength(1)
    // The bridge still answers.
    await expect(list(GLADE)).resolves.toEqual([domain('pypi.org')])
  })
})
