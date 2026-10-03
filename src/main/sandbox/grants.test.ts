// Sandbox grants (P15-04, #449): kept per task, per workspace and Glade-wide, applied to a session with
// `applyFlagSettings` straight after it starts or resumes, and to the running sessions they cover whenever they change.
// The agent is the fake backend, and the overlay P15-03's builder's stand-in (`./test-overlay`).
//
// What these prove is which grants reach which session, when, and in what order: an `overlay([...])` a session was sent
// says the runner handed the builder exactly those grants, that root and that mode. The assertions that look inside an
// overlay (`allowRead`, `allowWrite`, the `Read(//…)` and `WebFetch(domain:…)` rules, `additionalDirectories`,
// `autoAllowBashIfSandboxed`, the fixed parts with nothing granted) only show the stand-in's shape until they're
// pointed at P15-03's real builder (#448).
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { Effort, PermissionMode, TaskActivity, type Task, type Workspace } from '../../shared/domain'
import {
  FolderAccess,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import type { SandboxFlagSettings } from '../agent/backend'
import { FakeAgentBackend, settle, type FakeAgentSession } from '../agent/fake-backend'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import * as sdk from '../agent/test-sdk-messages'
import { addTaskPermissionRule } from '../db/repositories/task-permission-rules'
import { addSandboxGrant, listSandboxGrants, SandboxGrantChange } from '../db/repositories/sandbox-grants'
import { createTask, getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createWorkspace } from '../db/repositories/workspaces'
import { LogScope } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { changeTask, deleteTask } from '../tasks/service'
import { removeWorkspace } from '../workspaces/workspaces'
import {
  changeSandboxFolderAccess,
  grantedDomain,
  grantedFolder,
  grantSandboxAccess,
  revokeSandboxGrant,
  type SandboxGrantsContext,
  type SandboxOverlayBuilder,
} from './grants'
import { testSandboxOverlay } from './test-overlay'

const read = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.Read })
const readWrite = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.ReadWrite })
const domain = (host: string): Grant => ({ kind: SandboxGrantKind.Domain, domain: host })
const folderKey = (path: string) => ({ kind: SandboxGrantKind.Folder, path }) as const

const GLADE: SandboxGrantTarget = { scope: SandboxGrantScope.Glade }

/** Whether the temp folder's disk takes a name in any case, as APFS does by default: Linux runners' don't. */
const CASE_INSENSITIVE_DISK = existsSync(tmpdir().toUpperCase())
const ROOT = '/code/acme-api'
const OTHER_ROOT = '/code/acme-web'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let runner: AgentRunner
let log: MemoryLog
let grants: SandboxGrantsContext
let overlayBuilder: SandboxOverlayBuilder

/** Starts the app's runner on the database, as a launch does. */
function launch(): void {
  backend = new FakeAgentBackend()
  log = createMemoryLog(LogScope.Runner)
  runner = createAgentRunner({
    db: database.db,
    emit: () => undefined,
    backend,
    log: log.logger,
    sandboxOverlay: (input) => overlayBuilder(input),
  })
  grants = { db: database.db, runner }
}

beforeEach(() => {
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db, ROOT)
  task = sampleTask(database.db, workspace.id)
  overlayBuilder = testSandboxOverlay
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
})

const taskTarget = (id = task.id): SandboxGrantTarget => ({ scope: SandboxGrantScope.Task, taskId: id })
const workspaceTarget = (id = workspace.id): SandboxGrantTarget => ({
  scope: SandboxGrantScope.Workspace,
  workspaceId: id,
})

/** The overlay a task gets with these grants, in its root and mode. */
function overlay(given: readonly Grant[], root = ROOT, permissionMode = PermissionMode.AllowAll): SandboxFlagSettings {
  return testSandboxOverlay({ root, permissionMode, grants: given })
}

/** What the runner logged of each session that refused its grants. */
function refusals(): unknown[] {
  return log
    .withMessage("couldn't apply the sandbox grants: the session's next start applies them")
    .map(({ fields }) => fields)
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

function anotherTask(workspaceId = workspace.id, now = 3_000): Task {
  return createTask(database.db, { workspaceId, model: 'claude-sample-1', effort: Effort.Medium }, now)
}

function otherWorkspace(): Workspace {
  return createWorkspace(database.db, { name: 'Acme Web', rootPath: OTHER_ROOT }, 1_000)
}

describe('a session starting', () => {
  it('starts with no grant in its options, and gets them all through one applyFlagSettings before its first message', async () => {
    addSandboxGrant(database.db, { target: GLADE, grant: read('/opt/toolchain') }, 10)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite('/Users/sam/shared') }, 11)
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

    expect(session.options.flagSettings).toBeUndefined()
    expect(session.options.allowedRules).toEqual([{ toolName: 'Bash', ruleContent: 'npm test *' }])
    expect(session.flagSettings).toEqual([
      overlay([read('/opt/toolchain'), readWrite('/Users/sam/shared'), domain('registry.npmjs.org')]),
    ])
    expect(sentBeforeEachOverlay).toEqual([0])
    expect(session.sent).toHaveLength(1)
    expect(log.withMessage('sandbox grants applied').map(({ fields }) => fields)).toMatchObject([
      { taskId: task.id, reason: 'session started' },
    ])
  })

  it('still applies the fixed parts with nothing granted at all', async () => {
    const session = await startTask()

    expect(session.flagSettings).toEqual([overlay([])])
    expect(session.flagSettings[0]?.sandbox).toMatchObject({
      enabled: true,
      filesystem: { denyRead: ['/Users/sam', '/Users', '/Volumes'], allowRead: [ROOT], allowWrite: [ROOT] },
      network: { allowedDomains: [] },
      credentials: { files: [{ path: '/Users/sam/.ssh', mode: 'deny' }] },
    })
    expect(session.flagSettings[0]?.permissions).toEqual({ allow: [], additionalDirectories: [] })
  })

  it('applies nothing while the sandbox is off', async () => {
    overlayBuilder = () => null
    addSandboxGrant(database.db, { target: GLADE, grant: read('/opt/toolchain') })

    const session = await startTask()
    await grantSandboxAccess(grants, { target: GLADE, grant: domain('acme.dev') })

    expect(session.flagSettings).toEqual([])
    expect(session.options.flagSettings).toBeUndefined()
  })

  it('builds the overlay from the task’s root and permission mode', async () => {
    updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
    const builder = vi.fn(testSandboxOverlay)
    overlayBuilder = builder
    addSandboxGrant(database.db, { target: taskTarget(), grant: read('/opt/toolchain') })

    await startTask()

    expect(builder).toHaveBeenCalledWith({
      root: ROOT,
      permissionMode: PermissionMode.AskBeforeEdits,
      grants: [read('/opt/toolchain')],
    })
  })

  it('keeps domain grants out of the start options: only WebFetch rules in the overlay’s permissions.allow', async () => {
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: domain('registry.npmjs.org') })
    addSandboxGrant(database.db, { target: taskTarget(), grant: domain('acme.dev') })

    const session = await startTask()

    const [applied] = session.flagSettings
    expect(applied?.permissions?.allow).toEqual(['WebFetch(domain:registry.npmjs.org)', 'WebFetch(domain:acme.dev)'])
    expect(applied?.sandbox?.network).toEqual({ allowedDomains: [] })
    expect(JSON.stringify(session.options)).not.toContain('acme.dev')
    expect(session.options.allowedRules).toEqual([])
  })

  it('gets the same overlay when it resumes after a relaunch', async () => {
    addSandboxGrant(database.db, { target: GLADE, grant: read('/opt/toolchain') }, 10)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: domain('registry.npmjs.org') }, 11)
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite('/Users/sam/notes') }, 12)
    const first = await startTask()
    await finishTurn(first)

    runner.close()
    launch()
    runner.send(task.id, 'Carry on.')

    const resumed = backend.session
    expect(resumed.options.resumeSessionId).toBe(`session-${task.id}`)
    expect(resumed.options.flagSettings).toBeUndefined()
    expect(resumed.flagSettings).toEqual(first.flagSettings)
    expect(resumed.flagSettings).toEqual([
      overlay([read('/opt/toolchain'), domain('registry.npmjs.org'), readWrite('/Users/sam/notes')]),
    ])
  })

  it('gets the grants when a turn the app quit in resumes on launch', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: read('/opt/toolchain') })
    await startTask()
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)

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

    expect(backend.session.flagSettings).toEqual([overlay([read('/opt/toolchain')])])
    expect(sentBeforeOverlay).toEqual([0])
  })

  it('logs a session that refuses its grants, and still sends the message: the next start applies them', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: read('/opt/toolchain') })
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () => Promise.reject(new Error('settings refused'))
    }

    const session = await startTask()

    expect(session.sent).toHaveLength(1)
    expect(refusals()).toMatchObject([{ taskId: task.id, reason: 'session started', error: 'settings refused' }])
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

    const change = await grantSandboxAccess(grants, {
      target: workspaceTarget(),
      grant: readWrite('/Users/sam/shared'),
    })

    expect(change).toEqual({
      change: SandboxGrantChange.Added,
      sessions: { applied: [task.id, sibling.id], refused: [], pending: [] },
    })
    expect(first.flagSettings).toEqual([overlay([]), overlay([readWrite('/Users/sam/shared')])])
    expect(second.flagSettings).toEqual([overlay([]), overlay([readWrite('/Users/sam/shared')])])
    expect(third.flagSettings).toEqual([overlay([], OTHER_ROOT)])
    // No restarts: the same three sessions, none closed, and none started for the task that isn't running.
    expect(backend.sessions).toEqual([first, second, third])
    expect(backend.sessions.some(({ closed }) => closed)).toBe(false)
    expect(listSandboxGrants(database.db, workspaceTarget()).map(({ grant }) => grant)).toEqual([
      readWrite('/Users/sam/shared'),
    ])
    // The idle task in the workspace gets it as soon as it starts.
    const started = await startTask(idle.id)
    expect(started.flagSettings).toEqual([overlay([readWrite('/Users/sam/shared')])])
  })

  it('applies a Glade-wide grant to every running task, each in its own root', async () => {
    const elsewhere = anotherTask(otherWorkspace().id, 4_000)
    const first = await startTask(task.id)
    const second = await startTask(elsewhere.id)

    await grantSandboxAccess(grants, { target: GLADE, grant: read('/opt/toolchain') })

    expect(first.flagSettings.at(-1)).toEqual(overlay([read('/opt/toolchain')]))
    expect(second.flagSettings.at(-1)).toEqual(overlay([read('/opt/toolchain')], OTHER_ROOT))
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
    await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite('/Users/sam/notes') })

    expect(backend.sessions).toEqual([])
    const session = await startTask()
    expect(session.flagSettings).toEqual([overlay([readWrite('/Users/sam/notes')])])
  })

  it('saves a duplicate grant once, and applies the grants again all the same', async () => {
    const session = await startTask()
    await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite('/Users/sam/notes') })

    const again = await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite('/Users/sam/notes') })
    const narrower = await grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') })

    const sessions = { applied: [task.id], refused: [], pending: [] }
    expect(again).toEqual({ change: SandboxGrantChange.Unchanged, sessions })
    expect(narrower).toEqual({ change: SandboxGrantChange.Unchanged, sessions })
    expect(listSandboxGrants(database.db, taskTarget())).toHaveLength(1)
    const withNotes = overlay([readWrite('/Users/sam/notes')])
    expect(session.flagSettings).toEqual([overlay([]), withNotes, withNotes, withNotes])
  })

  it('tells the caller a session refused a grant, and granting it again repairs the session', async () => {
    const session = await startTask()
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings refused'))

    const refused = await grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') })

    expect(refused).toEqual({
      change: SandboxGrantChange.Added,
      sessions: { applied: [], refused: [task.id], pending: [] },
    })

    // The card comes up again, and you allow it again: the grant is already saved, and this time it reaches the session.
    session.onApplyFlagSettings = () => Promise.resolve()
    const repaired = await grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') })

    expect(repaired).toEqual({
      change: SandboxGrantChange.Unchanged,
      sessions: { applied: [task.id], refused: [], pending: [] },
    })
    expect(session.flagSettings).toHaveLength(3)
    expect(session.flagSettings.at(-1)).toEqual(overlay([read('/Users/sam/notes')]))
  })

  it('tells the caller a session kept a folder it refused to give up, and revoking again repairs it', async () => {
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite('/Users/sam/shared') })
    const sibling = anotherTask()
    const first = await startTask(task.id)
    const second = await startTask(sibling.id)
    second.onApplyFlagSettings = () => Promise.reject(new Error('settings refused'))

    const revoked = await revokeSandboxGrant(grants, workspaceTarget(), folderKey('/Users/sam/shared'))

    expect(revoked).toEqual({ removed: true, sessions: { applied: [task.id], refused: [sibling.id], pending: [] } })
    expect(listSandboxGrants(database.db, workspaceTarget())).toEqual([])

    second.onApplyFlagSettings = () => Promise.resolve()
    const again = await revokeSandboxGrant(grants, workspaceTarget(), folderKey('/Users/sam/shared'))

    expect(again).toEqual({ removed: false, sessions: { applied: [task.id, sibling.id], refused: [], pending: [] } })
    expect(first.flagSettings.at(-1)).toEqual(overlay([]))
    expect(second.flagSettings.at(-1)).toEqual(overlay([]))
  })

  it('tells the caller a session refused a downgrade', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite('/Users/sam/notes') })
    const session = await startTask()
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings refused'))

    const outcome = await changeSandboxFolderAccess(grants, taskTarget(), '/Users/sam/notes', FolderAccess.Read)

    expect(outcome).toEqual({
      change: SandboxGrantChange.Changed,
      sessions: { applied: [], refused: [task.id], pending: [] },
    })
    expect(listSandboxGrants(database.db, taskTarget()).map(({ grant }) => grant)).toEqual([read('/Users/sam/notes')])
  })

  it('waits only on the session that asked, while the others apply in the background', async () => {
    const sibling = anotherTask()
    const elsewhere = anotherTask(otherWorkspace().id, 4_000)
    const asking = await startTask(task.id)
    const stuck = await startTask(sibling.id)
    const uncovered = await startTask(elsewhere.id)
    // The sibling's Claude Code never answers.
    stuck.onApplyFlagSettings = () => new Promise<void>(() => undefined)

    const outcome = await grantSandboxAccess(
      grants,
      { target: workspaceTarget(), grant: read('/Users/sam/shared') },
      { awaitTaskId: task.id },
    )

    expect(outcome).toEqual({
      change: SandboxGrantChange.Added,
      sessions: { applied: [task.id], refused: [], pending: [sibling.id] },
    })
    // The stuck session was still sent the overlay; the one in the other workspace wasn't.
    expect(asking.flagSettings.at(-1)).toEqual(overlay([read('/Users/sam/shared')]))
    expect(stuck.flagSettings.at(-1)).toEqual(overlay([read('/Users/sam/shared')]))
    expect(uncovered.flagSettings).toEqual([overlay([], OTHER_ROOT)])
  })

  it('reports the asking session’s refusal, and leaves a background refusal to the log', async () => {
    const sibling = anotherTask()
    const asking = await startTask(task.id)
    const other = await startTask(sibling.id)
    asking.onApplyFlagSettings = () => Promise.reject(new Error('asking refused'))
    other.onApplyFlagSettings = () => Promise.reject(new Error('other refused'))

    const outcome = await revokeSandboxGrant(grants, workspaceTarget(), domain('acme.dev'), { awaitTaskId: task.id })
    await settle()

    expect(outcome).toEqual({ removed: false, sessions: { applied: [], refused: [task.id], pending: [sibling.id] } })
    expect(refusals()).toMatchObject([
      { taskId: task.id, error: 'asking refused' },
      { taskId: sibling.id, error: 'other refused' },
    ])
  })

  it('waits on no one when the asking task has no running session', async () => {
    const sibling = anotherTask()
    const running = await startTask(sibling.id)
    running.onApplyFlagSettings = () => new Promise<void>(() => undefined)

    const outcome = await changeSandboxFolderAccess(grants, GLADE, '/opt/toolchain', FolderAccess.Read, {
      awaitTaskId: task.id,
    })

    expect(outcome).toEqual({
      change: SandboxGrantChange.Unchanged,
      sessions: { applied: [], refused: [], pending: [sibling.id] },
    })
  })

  it('upgrades a read-only folder granted read-write, live', async () => {
    const session = await startTask()
    await grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') })
    expect(session.flagSettings.at(-1)).toEqual(overlay([read('/Users/sam/notes')]))

    expect(
      await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite('/Users/sam/notes') }),
    ).toMatchObject({ change: SandboxGrantChange.Changed })

    const upgraded = session.flagSettings.at(-1)
    expect(upgraded).toEqual(overlay([readWrite('/Users/sam/notes')]))
    expect(upgraded?.sandbox?.filesystem?.allowWrite).toEqual([ROOT, '/Users/sam/notes'])
    expect(upgraded?.permissions).toEqual({ allow: [], additionalDirectories: ['/Users/sam/notes'] })
  })

  it('takes a removed folder out of every list of the overlay', async () => {
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: readWrite('/Users/sam/shared') }, 10)
    addSandboxGrant(database.db, { target: workspaceTarget(), grant: read('/Users/sam/docs') }, 11)
    const session = await startTask()
    expect(JSON.stringify(session.flagSettings[0])).toContain('/Users/sam/shared')

    expect(await revokeSandboxGrant(grants, workspaceTarget(), folderKey('/Users/sam/shared'))).toMatchObject({
      removed: true,
    })
    expect(await revokeSandboxGrant(grants, workspaceTarget(), folderKey('/Users/sam/docs'))).toMatchObject({
      removed: true,
    })

    const [, withoutShared, withoutEither] = session.flagSettings
    expect(withoutShared).toEqual(overlay([read('/Users/sam/docs')]))
    expect(JSON.stringify(withoutShared)).not.toContain('/Users/sam/shared')
    expect(withoutEither).toEqual(overlay([]))
    expect(withoutEither?.sandbox?.filesystem).toMatchObject({ allowRead: [ROOT], allowWrite: [ROOT] })
    expect(withoutEither?.permissions).toEqual({ allow: [], additionalDirectories: [] })
    expect(backend.sessions).toEqual([session])
  })

  it('downgrades a read-write folder to read-only: out of allowWrite and additionalDirectories, into a Read rule', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite('/Users/sam/notes') })
    const session = await startTask()

    expect(await changeSandboxFolderAccess(grants, taskTarget(), '/Users/sam/notes', FolderAccess.Read)).toMatchObject({
      change: SandboxGrantChange.Changed,
    })

    const downgraded = session.flagSettings.at(-1)
    expect(downgraded).toEqual(overlay([read('/Users/sam/notes')]))
    expect(downgraded?.sandbox?.filesystem).toMatchObject({ allowRead: [ROOT, '/Users/sam/notes'], allowWrite: [ROOT] })
    expect(downgraded?.permissions).toEqual({ allow: ['Read(//Users/sam/notes/**)'], additionalDirectories: [] })
  })

  it('keeps a folder read-write while another scope still grants it so', async () => {
    addSandboxGrant(database.db, { target: GLADE, grant: readWrite('/opt/toolchain') })
    addSandboxGrant(database.db, { target: taskTarget(), grant: readWrite('/opt/toolchain') })
    const session = await startTask()

    await changeSandboxFolderAccess(grants, taskTarget(), '/opt/toolchain', FolderAccess.Read)
    expect(session.flagSettings.at(-1)).toEqual(overlay([readWrite('/opt/toolchain')]))

    await revokeSandboxGrant(grants, GLADE, folderKey('/opt/toolchain'))
    expect(session.flagSettings.at(-1)).toEqual(overlay([read('/opt/toolchain')]))
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
    const sessions = { applied: [task.id], refused: [], pending: [] }

    expect(await revokeSandboxGrant(grants, taskTarget(), folderKey('/Users/sam/notes'))).toEqual({
      removed: false,
      sessions,
    })
    expect(await changeSandboxFolderAccess(grants, taskTarget(), '/Users/sam/notes', FolderAccess.Read)).toEqual({
      change: SandboxGrantChange.Unchanged,
      sessions,
    })
    expect(session.flagSettings).toEqual([overlay([]), overlay([]), overlay([])])
  })

  it('applies a grant mid-turn, without stopping or restarting the turn', async () => {
    const session = await startTask()
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)

    await grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') })

    expect(session.flagSettings.at(-1)).toEqual(overlay([read('/Users/sam/notes')]))
    expect(session.interrupts).toBe(0)
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)
    await finishTurn(session)
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Waiting)
    expect(backend.sessions).toEqual([session])
  })

  it('applies a grant between turns, to the session that waits for the next one', async () => {
    const session = await startTask()
    await finishTurn(session)

    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: domain('acme.dev') })
    runner.send(task.id, 'Now fetch the docs.')

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
    const granting = grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') }).then(() => {
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
    addSandboxGrant(database.db, { target: taskTarget(), grant: read('/Users/sam/notes') }, 10)
    addSandboxGrant(database.db, { target: taskTarget(), grant: domain('acme.dev') }, 11)
    // The first overlay hasn't finished applying when the grant goes.
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

    await revokeSandboxGrant(grants, taskTarget(), folderKey('/Users/sam/notes'))
    firstApplied()
    await settle()

    // Applied in order, so the session ends up with the second, the whole overlay without the grant.
    expect(session.flagSettings).toEqual([
      overlay([read('/Users/sam/notes'), domain('acme.dev')]),
      overlay([domain('acme.dev')]),
    ])
  })

  it('logs a session that refuses a change, keeps the grant, and applies it on the next start', async () => {
    const session = await startTask()
    await finishTurn(session)
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings refused'))

    const change = await grantSandboxAccess(grants, { target: taskTarget(), grant: readWrite('/Users/sam/notes') })

    expect(change).toEqual({
      change: SandboxGrantChange.Added,
      sessions: { applied: [], refused: [task.id], pending: [] },
    })
    expect(listSandboxGrants(database.db, taskTarget()).map(({ grant }) => grant)).toEqual([
      readWrite('/Users/sam/notes'),
    ])
    expect(refusals()).toMatchObject([{ taskId: task.id, reason: 'grants changed', error: 'settings refused' }])

    runner.close()
    launch()
    runner.send(task.id, 'Carry on.')
    expect(backend.session.flagSettings).toEqual([overlay([readWrite('/Users/sam/notes')])])
  })

  it('applies many grants as one overlay each time', async () => {
    const session = await startTask()
    const many: Grant[] = []
    for (let index = 0; index < 50; index += 1) {
      many.push(read(`/opt/tool-${String(index)}`), domain(`host-${String(index)}.acme.dev`))
    }
    for (const grant of many) await grantSandboxAccess(grants, { target: workspaceTarget(), grant })

    expect(session.flagSettings).toHaveLength(101)
    expect(session.flagSettings.at(-1)).toEqual(overlay(many))
    expect(session.flagSettings.at(-1)?.permissions?.allow).toHaveLength(100)
  })

  it('applies a mode change with the grants still in the overlay', async () => {
    addSandboxGrant(database.db, { target: taskTarget(), grant: read('/Users/sam/notes') })
    const session = await startTask()

    changeTask({ db: database.db, emit: () => undefined, runner }, task.id, {
      permissionMode: PermissionMode.AskBeforeEdits,
    })
    await settle()

    expect(session.flagSettings.at(-1)).toEqual(
      overlay([read('/Users/sam/notes')], ROOT, PermissionMode.AskBeforeEdits),
    )
    expect(session.flagSettings.at(-1)?.sandbox?.autoAllowBashIfSandboxed).toBe(false)
    expect(log.withMessage('sandbox grants applied').at(-1)?.fields).toMatchObject({
      reason: 'permission mode changed',
    })
  })

  it('leaves a session the app closed alone', async () => {
    await startTask()
    runner.close()

    await grantSandboxAccess(grants, { target: GLADE, grant: domain('acme.dev') })

    expect(backend.session.flagSettings).toEqual([overlay([])])
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
      changeSandboxFolderAccess(grants, workspaceTarget('nothing'), '/opt/sdk', FolderAccess.Read),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
  })

  it('keeps folders absolute and resolved, and domains bare and lower case', async () => {
    await grantSandboxAccess(grants, { target: GLADE, grant: readWrite('/opt/toolchain/') })
    await grantSandboxAccess(grants, { target: GLADE, grant: read('/opt/other/../toolchain') })
    await grantSandboxAccess(grants, { target: GLADE, grant: domain('  Registry.NPMJS.org ') })
    await grantSandboxAccess(grants, { target: GLADE, grant: domain('*.acme.dev') })
    await grantSandboxAccess(grants, { target: GLADE, grant: read('/Users/sam/My Notes/naïve') })

    expect(listSandboxGrants(database.db, GLADE).map(({ grant }) => grant)).toEqual([
      readWrite('/opt/toolchain'),
      domain('registry.npmjs.org'),
      domain('*.acme.dev'),
      read('/Users/sam/My Notes/naïve'),
    ])

    expect(await revokeSandboxGrant(grants, GLADE, folderKey('/opt/toolchain/'))).toMatchObject({ removed: true })
    expect(await revokeSandboxGrant(grants, GLADE, domain('REGISTRY.npmjs.org'))).toMatchObject({ removed: true })
  })

  it.each(['notes', '~/notes', './notes', ''])('refuses the relative folder %j', (path) => {
    expect(() => grantedFolder(path)).toThrow(expect.objectContaining({ code: BridgeErrorCode.InvalidRequest }))
  })

  it.each([
    '/Users/sam/*',
    '/Users/sam/**',
    '/Users/sam/**/notes',
    '/Users/sam/note?',
    '/Users/sam/[ab]',
    '/Users/sam/notes]',
    '/Users/sam/{notes,docs}',
    '/Users/sam/notes}',
    '/*',
  ])('refuses the pattern %j as a folder: a grant is one folder', (path) => {
    expect(() => grantedFolder(path)).toThrow(expect.objectContaining({ code: BridgeErrorCode.InvalidRequest }))
  })

  it.each([
    ['registry.npmjs.org', 'registry.npmjs.org'],
    ['localhost', 'localhost'],
    ['  Registry.NPMJS.org ', 'registry.npmjs.org'],
    ['*.acme.dev', '*.acme.dev'],
    ['*.API.acme.dev', '*.api.acme.dev'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['10.0.0.1', '10.0.0.1'],
  ])('keeps the domain %j as %j', (written, kept) => {
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
    expect(() => grantedDomain(written)).toThrow(expect.objectContaining({ code: BridgeErrorCode.InvalidRequest }))
  })

  it('saves nothing for a grant it refuses', async () => {
    await expect(grantSandboxAccess(grants, { target: GLADE, grant: read('notes') })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    await expect(changeSandboxFolderAccess(grants, GLADE, 'notes', FolderAccess.Read)).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    await expect(revokeSandboxGrant(grants, GLADE, domain('https://acme.dev'))).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    await expect(grantSandboxAccess(grants, { target: GLADE, grant: readWrite('/Users/sam/*') })).rejects.toMatchObject(
      { code: BridgeErrorCode.InvalidRequest },
    )
    await expect(grantSandboxAccess(grants, { target: GLADE, grant: domain('*.com') })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    await expect(revokeSandboxGrant(grants, GLADE, folderKey('/Users/sam/[ab]'))).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    expect(listSandboxGrants(database.db, GLADE)).toEqual([])
    expect(backend.sessions).toEqual([])
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

    expect(first.change).toBe(SandboxGrantChange.Added)
    expect(second.change).toBe(SandboxGrantChange.Unchanged)
    expect(third.change).toBe(SandboxGrantChange.Changed)
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

  it('keeps a folder that doesn’t exist as written, tidied', async () => {
    const missing = join(link, 'not', 'made', 'yet')

    await grantSandboxAccess(grants, { target: GLADE, grant: read(`${missing}/../yet/`) })

    expect(kept()).toEqual([read(missing)])
  })

  it('still finds a folder granted before it existed once it does, to change it or take it back', async () => {
    const written = join(link, 'later')
    await grantSandboxAccess(grants, { target: GLADE, grant: readWrite(written) })
    expect(kept()).toEqual([readWrite(written)])
    mkdirSync(join(scratch, 'disk', 'later'))

    expect(await changeSandboxFolderAccess(grants, GLADE, written, FolderAccess.Read)).toMatchObject({
      change: SandboxGrantChange.Changed,
    })
    expect(kept()).toEqual([read(written)])
    expect(await revokeSandboxGrant(grants, GLADE, folderKey(written))).toMatchObject({ removed: true })
    expect(kept()).toEqual([])
  })

  it('refuses a symlink to a folder whose real name is a pattern', () => {
    mkdirSync(join(scratch, 'disk', '[drafts]'))
    symlinkSync(join(scratch, 'disk', '[drafts]'), join(scratch, 'drafts'))

    expect(() => grantedFolder(join(scratch, 'drafts'))).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.InvalidRequest }),
    )
  })
})

describe('grants going with what they belong to', () => {
  it('deletes a task’s grants with the task, and keeps the workspace’s and Glade’s', async () => {
    const sibling = anotherTask()
    await grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') })
    await grantSandboxAccess(grants, { target: taskTarget(sibling.id), grant: domain('acme.dev') })
    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: domain('registry.npmjs.org') })
    await grantSandboxAccess(grants, { target: GLADE, grant: read('/opt/toolchain') })
    await startTask()

    deleteTask({ db: database.db, emit: () => undefined, runner }, task.id)

    expect(listSandboxGrants(database.db, taskTarget())).toEqual([])
    expect(listSandboxGrants(database.db, taskTarget(sibling.id))).toHaveLength(1)
    expect(listSandboxGrants(database.db, workspaceTarget())).toHaveLength(1)
    expect(listSandboxGrants(database.db, GLADE)).toHaveLength(1)
    // The deleted task's session is gone: a later grant reaches no one.
    await grantSandboxAccess(grants, { target: GLADE, grant: domain('acme.dev') })
    expect(backend.session.flagSettings).toHaveLength(1)
  })

  it('deletes a workspace’s grants, and its tasks’, when it’s removed, and keeps Glade’s and other workspaces’', async () => {
    const web = otherWorkspace()
    const webTask = anotherTask(web.id)
    await grantSandboxAccess(grants, { target: taskTarget(), grant: read('/Users/sam/notes') })
    await grantSandboxAccess(grants, { target: workspaceTarget(), grant: domain('registry.npmjs.org') })
    await grantSandboxAccess(grants, { target: workspaceTarget(web.id), grant: domain('web.dev') })
    await grantSandboxAccess(grants, { target: taskTarget(webTask.id), grant: domain('cdn.web.dev') })
    await grantSandboxAccess(grants, { target: GLADE, grant: read('/opt/toolchain') })

    removeWorkspace(
      { db: database.db, emit: () => undefined, runner, terminals: { closeWorkspace: () => undefined } },
      workspace.id,
    )

    expect(listSandboxGrants(database.db, taskTarget())).toEqual([])
    expect(listSandboxGrants(database.db, workspaceTarget())).toEqual([])
    expect(listSandboxGrants(database.db, workspaceTarget(web.id))).toHaveLength(1)
    expect(listSandboxGrants(database.db, taskTarget(webTask.id))).toHaveLength(1)
    expect(listSandboxGrants(database.db, GLADE)).toHaveLength(1)
  })
})
