import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import {
  PermissionDecisionKind,
  PermissionDestination,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  TaskActivity,
  UiStateKey,
  type PermissionDecision,
  type Task,
} from '../../shared/domain'
import type { NewPermissionRequest } from '../db/repositories/permission-requests'
import { getPermissionRequest, listPermissionRequests } from '../db/repositories/permission-requests'
import { listTaskPermissionRules } from '../db/repositories/task-permission-rules'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import {
  FolderAccess,
  SandboxAskKind,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type SandboxAsk,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import { CommandFailure } from '../bridge/errors'
import { listSandboxGrants } from '../db/repositories/sandbox-grants'
import { setHomeFolder } from '../../shared/homeFolder'
import { cardGrantTarget, createPermissionBroker, FOLDER_MOVED_NOTE, type PermissionBroker } from './permissions'

let database: TestDatabase
let task: Task
let events: GladeEvent[]
let notify: ReturnType<typeof vi.fn<(taskId: string, text: string) => void>>
let broker: PermissionBroker

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  updateTask(database.db, task.id, { activity: TaskActivity.Working, sessionId: 'session-1' })
  // You're viewing the task, so its requests notify nothing; see "notifications" below for one you aren't.
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  events = []
  notify = vi.fn()
  broker = createPermissionBroker({ db: database.db, emit: (event) => events.push(event) }, notify)
})

afterEach(() => {
  database.close()
})

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** A request for a call of `toolName`, in `task`. */
function call(toolUseId: string, toolName = 'Bash', input: Record<string, unknown> = { command: 'npm test' }) {
  return {
    taskId: task.id,
    turn: 1,
    toolUseId,
    agentId: null,
    toolName,
    input,
    title: null,
    displayName: toolName,
    description: null,
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
  } satisfies NewPermissionRequest
}

/** The events since the last call, as each one's type and what matters for it. */
function drain(): unknown[] {
  return events.splice(0).map((event) => {
    if (event.type === EventType.TaskUpdated) return [event.type, event.task.activity, event.task.awaitingPermission]
    if ('permissionRequest' in event) return [event.type, event.permissionRequest.state]
    return [event.type]
  })
}

/** A failure's code, for comparing. */
function failure(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error instanceof Error && 'code' in error ? error.code : error
  }
  return undefined
}

const ALLOW_ONCE = { kind: PermissionDecisionKind.AllowOnce } as const

describe('the permission broker', () => {
  it('opens a request that waits, saved and broadcast, with the task waiting on you', async () => {
    const pending = broker.request(call('toolu_1'))

    expect(pending.request).toMatchObject({ state: PermissionRequestState.Open, toolUseId: 'toolu_1', denyNote: null })
    expect(getPermissionRequest(database.db, pending.request.id)).toEqual(pending.request)
    expect(broker.isWaiting(pending.request.id)).toBe(true)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(drain()).toEqual([
      [EventType.PermissionOpened, PermissionRequestState.Open],
      [EventType.TaskUpdated, TaskActivity.Waiting, true],
    ])

    const answered = broker.answer(pending.request.id, ALLOW_ONCE)
    await expect(pending.decision).resolves.toEqual(ALLOW_ONCE)
    expect(answered).toMatchObject({ state: PermissionRequestState.Allowed, closedAt: expect.any(Number) as unknown })
    expect(broker.isWaiting(pending.request.id)).toBe(false)
    expect(current().awaitingPermission).toBe(false)
    expect(drain()).toEqual([
      [EventType.PermissionAnswered, PermissionRequestState.Allowed],
      [EventType.TaskUpdated, TaskActivity.Waiting, false],
    ])
  })

  it('keeps a deny note, trimmed, and drops a blank one', async () => {
    const noted = broker.request(call('toolu_1'))
    const blank = broker.request(call('toolu_2'))

    expect(broker.answer(noted.request.id, { kind: PermissionDecisionKind.Deny, note: '  Use pnpm.  ' })).toMatchObject(
      { state: PermissionRequestState.Denied, denyNote: 'Use pnpm.' },
    )
    expect(broker.answer(blank.request.id, { kind: PermissionDecisionKind.Deny, note: '   ' })).toMatchObject({
      state: PermissionRequestState.Denied,
      denyNote: null,
    })
    await expect(noted.decision).resolves.toEqual({ kind: PermissionDecisionKind.Deny, note: '  Use pnpm.  ' })
  })

  it("doesn't stamp a task already waiting on you as changed when a request opens", () => {
    updateTask(database.db, task.id, { activity: TaskActivity.Waiting }, 5_000)

    broker.request(call('toolu_1'))

    expect(current()).toMatchObject({ updatedAt: 5_000, awaitingPermission: true })
    expect(drain()).toEqual([
      [EventType.PermissionOpened, PermissionRequestState.Open],
      [EventType.TaskUpdated, TaskActivity.Waiting, true],
    ])
  })

  it('gives parallel calls a request each, answered in any order', async () => {
    const first = broker.request(call('toolu_1'))
    const second = broker.request(call('toolu_2', 'Edit', { file_path: 'a.txt' }))

    broker.answer(second.request.id, { kind: PermissionDecisionKind.Deny })
    expect(current().awaitingPermission).toBe(true)
    broker.answer(first.request.id, ALLOW_ONCE)

    await expect(second.decision).resolves.toEqual({ kind: PermissionDecisionKind.Deny })
    await expect(first.decision).resolves.toEqual(ALLOW_ONCE)
    expect(current().awaitingPermission).toBe(false)
    expect(listPermissionRequests(database.db, task.id).map(({ toolUseId, state }) => [toolUseId, state])).toEqual([
      ['toolu_1', PermissionRequestState.Allowed],
      ['toolu_2', PermissionRequestState.Denied],
    ])
  })

  it('refuses to answer a request that is gone, answered or withdrawn, and leaves it as it was', async () => {
    const answered = broker.request(call('toolu_1'))
    const withdrawn = broker.request(call('toolu_2'))
    broker.answer(answered.request.id, ALLOW_ONCE)
    broker.withdraw(withdrawn.request.id)
    await expect(withdrawn.decision).resolves.toBeNull()

    expect(failure(() => broker.answer('missing', ALLOW_ONCE))).toBe(BridgeErrorCode.NotFound)
    expect(failure(() => broker.answer(answered.request.id, { kind: PermissionDecisionKind.Deny }))).toBe(
      BridgeErrorCode.InvalidTransition,
    )
    expect(failure(() => broker.answer(withdrawn.request.id, ALLOW_ONCE))).toBe(BridgeErrorCode.InvalidTransition)
    expect(getPermissionRequest(database.db, answered.request.id)?.state).toBe(PermissionRequestState.Allowed)
    expect(getPermissionRequest(database.db, withdrawn.request.id)?.state).toBe(PermissionRequestState.Withdrawn)
  })

  it('withdraws a request when the SDK cancels its call, even one cancelled before it opened', async () => {
    const controller = new AbortController()
    const pending = broker.request(call('toolu_1'), controller.signal)
    controller.abort()
    await expect(pending.decision).resolves.toBeNull()
    expect(getPermissionRequest(database.db, pending.request.id)?.state).toBe(PermissionRequestState.Withdrawn)

    const early = broker.request(call('toolu_2'), AbortSignal.abort())
    await expect(early.decision).resolves.toBeNull()
    expect(current().awaitingPermission).toBe(false)
  })

  it("ignores the SDK cancelling a call once it's answered", async () => {
    const controller = new AbortController()
    const pending = broker.request(call('toolu_1'), controller.signal)
    broker.answer(pending.request.id, ALLOW_ONCE)
    controller.abort()

    await expect(pending.decision).resolves.toEqual(ALLOW_ONCE)
    expect(getPermissionRequest(database.db, pending.request.id)?.state).toBe(PermissionRequestState.Allowed)
  })

  it("withdraws all of a task's open requests, and only its", async () => {
    const other = sampleTask(database.db, task.workspaceId)
    const mine = [broker.request(call('toolu_1')), broker.request(call('toolu_2'))]
    const theirs = broker.request({ ...call('toolu_3'), taskId: other.id })

    broker.withdrawAll(task.id)
    broker.withdraw(mine[0]?.request.id ?? '')

    await expect(Promise.all(mine.map(({ decision }) => decision))).resolves.toEqual([null, null])
    expect(broker.isWaiting(theirs.request.id)).toBe(true)
    expect(getTask(database.db, other.id)?.awaitingPermission).toBe(true)
  })

  it('lets go of its calls when the app quits, leaving their requests open for the next launch', () => {
    const pending = broker.request(call('toolu_1'))

    broker.close()

    expect(broker.isWaiting(pending.request.id)).toBe(false)
    expect(current().awaitingPermission).toBe(true)
    // Answering it then just closes it: nothing waits on it.
    expect(broker.answer(pending.request.id, ALLOW_ONCE).state).toBe(PermissionRequestState.Allowed)
  })
})

describe('the permission broker: Allow for this task', () => {
  const FOR_TASK: PermissionDecision = { kind: PermissionDecisionKind.AllowForTask }
  const NPM_TEST = { toolName: 'Bash', ruleContent: 'npm test *' }

  /** A `Bash` call Claude Code suggests a rule for, as it does (for a settings file). */
  function bash(toolUseId: string, ...ruleContents: string[]) {
    return {
      ...call(toolUseId),
      suggestions: [
        {
          type: PermissionUpdateType.AddRules,
          rules: ruleContents.map((ruleContent) => ({ toolName: 'Bash', ruleContent })),
          behavior: PermissionRuleBehavior.Allow,
          destination: PermissionDestination.LocalSettings,
        },
      ],
    } satisfies NewPermissionRequest
  }

  const rules = (taskId = task.id): unknown[] => listTaskPermissionRules(database.db, taskId).map(({ rule }) => rule)

  it('allows the call, and grants the task the rule, saved with the answer', async () => {
    const pending = broker.request(bash('toolu_1', 'npm test *'))

    const answered = broker.answer(pending.request.id, FOR_TASK)

    expect(answered).toMatchObject({ state: PermissionRequestState.Allowed, grantedRule: NPM_TEST })
    await expect(pending.decision).resolves.toEqual(FOR_TASK)
    expect(rules()).toEqual([NPM_TEST])
    expect(drain()).toEqual([
      [EventType.PermissionOpened, PermissionRequestState.Open],
      [EventType.TaskUpdated, TaskActivity.Waiting, true],
      [EventType.PermissionAnswered, PermissionRequestState.Allowed],
      [EventType.TaskUpdated, TaskActivity.Waiting, false],
    ])
  })

  it('grants the whole tool when no rule is suggested, as for an Edit', () => {
    const pending = broker.request(call('toolu_1', 'Edit', { file_path: 'CHANGELOG.md' }))

    broker.answer(pending.request.id, FOR_TASK)

    expect(rules()).toEqual([{ toolName: 'Edit' }])
  })

  it('keeps one rule when the same one is granted twice, as with a second card for the same call', async () => {
    const first = broker.request(bash('toolu_1', 'npm test *'))
    const second = broker.request(bash('toolu_2', 'npm test *'))

    broker.answer(first.request.id, FOR_TASK)
    // The second card stayed open, and can be answered on its own, the same way or another.
    expect(getPermissionRequest(database.db, second.request.id)?.state).toBe(PermissionRequestState.Open)
    expect(broker.isWaiting(second.request.id)).toBe(true)
    broker.answer(second.request.id, FOR_TASK)

    await expect(second.decision).resolves.toEqual(FOR_TASK)
    expect(rules()).toEqual([NPM_TEST])
  })

  it('refuses it where it isn’t offered, granting nothing and leaving the request open', () => {
    const suppressed = broker.request({ ...bash('toolu_1', 'npm test *'), suppressAlwaysAllowRule: true })
    const noRule = broker.request(call('toolu_2'))
    const compound = broker.request(bash('toolu_3', 'npm test *', 'rm -rf build'))

    for (const { request } of [suppressed, noRule, compound]) {
      expect(failure(() => broker.answer(request.id, FOR_TASK))).toBe(BridgeErrorCode.InvalidRequest)
      expect(getPermissionRequest(database.db, request.id)?.state).toBe(PermissionRequestState.Open)
      expect(broker.isWaiting(request.id)).toBe(true)
    }
    expect(rules()).toEqual([])
    // Allow once still answers them.
    expect(broker.answer(suppressed.request.id, ALLOW_ONCE).grantedRule).toBeNull()
  })

  it('refuses it on a request that is gone or closed, before asking whether it would grant anything', () => {
    const answered = broker.request(call('toolu_1'))
    broker.answer(answered.request.id, ALLOW_ONCE)

    expect(failure(() => broker.answer('missing', FOR_TASK))).toBe(BridgeErrorCode.NotFound)
    expect(failure(() => broker.answer(answered.request.id, FOR_TASK))).toBe(BridgeErrorCode.InvalidTransition)
    expect(rules()).toEqual([])
  })

  it('grants a request left open by a relaunch, with nothing waiting on it', () => {
    const pending = broker.request(bash('toolu_1', 'npm test *'))
    broker.close()

    broker.answer(pending.request.id, FOR_TASK)

    expect(rules()).toEqual([NPM_TEST])
  })

  it('grants each task its own rules, and many of them', () => {
    const other = sampleTask(database.db, task.workspaceId)
    const many = Array.from({ length: 50 }, (_, index) => `make step-${String(index)} *`)
    for (const [index, content] of many.entries()) {
      broker.answer(broker.request(bash(`toolu_${String(index)}`, content)).request.id, FOR_TASK)
    }
    broker.answer(broker.request({ ...call('toolu_other', 'Edit'), taskId: other.id }).request.id, FOR_TASK)

    expect(rules()).toEqual(many.map((ruleContent) => ({ toolName: 'Bash', ruleContent })))
    expect(rules(other.id)).toEqual([{ toolName: 'Edit' }])
  })

  it('saves neither the answer nor the rule when saving the rule fails', () => {
    const pending = broker.request(bash('toolu_1', 'npm test *'))
    database.db.exec(
      `CREATE TRIGGER no_rules BEFORE INSERT ON task_permission_rules BEGIN SELECT RAISE(ABORT, 'full'); END`,
    )

    expect(() => broker.answer(pending.request.id, FOR_TASK)).toThrow(/full/)

    expect(getPermissionRequest(database.db, pending.request.id)?.state).toBe(PermissionRequestState.Open)
    expect(broker.isWaiting(pending.request.id)).toBe(true)
    expect(rules()).toEqual([])
  })
})

describe('the permission broker: notifications', () => {
  it('marks a task you aren’t viewing unread and notifies the tool and its command or file', () => {
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: '' })

    broker.request(call('toolu_1'))
    broker.request(call('toolu_2', 'Edit', { file_path: 'src/date.ts' }))
    broker.request(call('toolu_3', 'mcp__github__create_issue', { title: 'Flaky test' }))

    expect(current().unread).toBe(true)
    expect(notify.mock.calls).toEqual([
      [task.id, 'Bash: npm test'],
      [task.id, 'Edit: src/date.ts'],
      [task.id, 'mcp__github__create_issue'],
    ])
  })

  it('notifies nothing, and leaves the task read, when you’re viewing it', () => {
    broker.request(call('toolu_1'))

    expect(current().unread).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies nothing by default', () => {
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: '' })
    const quiet = createPermissionBroker({ db: database.db, emit: () => undefined })

    quiet.request(call('toolu_1'))

    expect(current().unread).toBe(true)
  })
})

describe("the permission broker: the sandbox's cards", () => {
  const WEB = '/Users/me/code/acme-web'
  const FOLDER: SandboxAsk = { kind: SandboxAskKind.Folder, path: WEB, access: FolderAccess.Read }
  const DOMAIN: SandboxAsk = {
    kind: SandboxAskKind.Domain,
    domain: 'registry.npmjs.org',
    command: 'npm install',
    commandDescription: null,
  }
  const OUTSIDE: SandboxAsk = { kind: SandboxAskKind.Outside }
  const ONCE: PermissionDecision = { kind: PermissionDecisionKind.AllowOnce }
  const FOR_TASK: PermissionDecision = { kind: PermissionDecisionKind.AllowForTask }
  const FOR_WORKSPACE: PermissionDecision = { kind: PermissionDecisionKind.AllowForWorkspace }

  /** A request of the sandbox's for a call. */
  function asking(toolUseId: string, sandbox: SandboxAsk): NewPermissionRequest {
    return { ...call(toolUseId, 'Read', { file_path: `${WEB}/package.json` }), suppressAlwaysAllowRule: true, sandbox }
  }

  function granted(target: SandboxGrantTarget): Grant[] {
    return listSandboxGrants(database.db, target).map(({ grant }) => grant)
  }

  const taskTarget = (): SandboxGrantTarget => ({ scope: SandboxGrantScope.Task, taskId: task.id })
  const workspaceTarget = (): SandboxGrantTarget => ({
    scope: SandboxGrantScope.Workspace,
    workspaceId: task.workspaceId,
  })

  function refusal(action: () => unknown): unknown {
    try {
      action()
    } catch (error) {
      return error instanceof CommandFailure ? error.code : error
    }
    return null
  }

  it('grants a folder to the task, saved with the answer: no rule, and never once', async () => {
    const pending = broker.request(asking('toolu_1', FOLDER))
    const { id } = pending.request

    expect(refusal(() => broker.answer(id, ONCE))).toBe(BridgeErrorCode.InvalidRequest)
    expect(getPermissionRequest(database.db, id)?.state).toBe(PermissionRequestState.Open)
    expect(granted(taskTarget())).toEqual([])

    const answered = broker.answer(id, FOR_TASK)

    expect(answered).toMatchObject({
      state: PermissionRequestState.Allowed,
      grantedScope: SandboxGrantScope.Task,
      grantedRule: null,
      sandbox: FOLDER,
    })
    expect(granted(taskTarget())).toEqual([{ kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.Read }])
    expect(granted(workspaceTarget())).toEqual([])
    expect(listTaskPermissionRules(database.db, task.id)).toEqual([])
    await expect(pending.decision).resolves.toEqual(FOR_TASK)
  })

  it('grants a domain to the workspace, and a folder its wider access when asked again', () => {
    const domain = broker.request(asking('toolu_1', DOMAIN))
    const read = broker.request(asking('toolu_2', FOLDER))
    const write = broker.request(asking('toolu_3', { ...FOLDER, access: FolderAccess.ReadWrite }))

    expect(broker.answer(domain.request.id, FOR_WORKSPACE).grantedScope).toBe(SandboxGrantScope.Workspace)
    broker.answer(read.request.id, FOR_WORKSPACE)
    broker.answer(write.request.id, FOR_WORKSPACE)

    expect(granted(workspaceTarget())).toEqual([
      { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' },
      { kind: SandboxGrantKind.Folder, path: WEB, access: FolderAccess.ReadWrite },
    ])
    expect(granted(taskTarget())).toEqual([])
  })

  it('allows running outside the sandbox once, and remembers nothing', () => {
    const pending = broker.request(asking('toolu_1', OUTSIDE))
    const { id } = pending.request

    for (const remembered of [FOR_TASK, FOR_WORKSPACE]) {
      expect(refusal(() => broker.answer(id, remembered))).toBe(BridgeErrorCode.InvalidRequest)
    }
    expect(broker.answer(id, ONCE)).toMatchObject({ grantedScope: null, grantedRule: null })
    expect(granted(taskTarget())).toEqual([])
    expect(listTaskPermissionRules(database.db, task.id)).toEqual([])
  })

  it('refuses Allow for this workspace on a call that asks nothing of the sandbox', () => {
    const pending = broker.request(call('toolu_1', 'Edit', { file_path: 'src/date.ts' }))

    expect(refusal(() => broker.answer(pending.request.id, FOR_WORKSPACE))).toBe(BridgeErrorCode.InvalidRequest)
    expect(getPermissionRequest(database.db, pending.request.id)?.state).toBe(PermissionRequestState.Open)
  })

  it('denies a folder with the note, granting nothing', async () => {
    const pending = broker.request(asking('toolu_1', FOLDER))

    const answered = broker.answer(pending.request.id, { kind: PermissionDecisionKind.Deny, note: ' Not that one. ' })

    expect(answered).toMatchObject({
      state: PermissionRequestState.Denied,
      denyNote: 'Not that one.',
      grantedScope: null,
    })
    expect(granted(taskTarget())).toEqual([])
    await expect(pending.decision).resolves.toMatchObject({ kind: PermissionDecisionKind.Deny })
  })

  it('saves neither the answer nor the grant when the grant can’t be saved', () => {
    // A folder no grant can name: the whole disk.
    const pending = broker.request(asking('toolu_1', { ...FOLDER, path: '/' }))

    expect(refusal(() => broker.answer(pending.request.id, FOR_TASK))).toBe(BridgeErrorCode.InvalidRequest)

    expect(getPermissionRequest(database.db, pending.request.id)).toMatchObject({
      state: PermissionRequestState.Open,
      grantedScope: null,
    })
    expect(granted(taskTarget())).toEqual([])
    expect(broker.isWaiting(pending.request.id)).toBe(true)
  })

  describe('a folder that moves while its card is open', () => {
    let scratch: string
    /** A real folder, asked for by where it really is, as a card names one. */
    let cache: string
    /** Somewhere the card never showed. */
    let documents: string

    beforeEach(() => {
      scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'glade-broker-')))
      cache = join(scratch, 'scratch', 'cache')
      documents = join(scratch, 'Documents')
      mkdirSync(cache, { recursive: true })
      mkdirSync(documents)
    })

    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true })
    })

    /** Swaps the folder for a link to somewhere else, as a command in a granted folder above it could. */
    function swap(folder: string, target: string): void {
      renameSync(folder, `${folder}.was`)
      symlinkSync(target, folder)
    }

    it.each([FOR_TASK, FOR_WORKSPACE])(
      'refuses to grant it: the request closes denied, with why, and nothing is granted (%o)',
      async (allow) => {
        const ask: SandboxAsk = { kind: SandboxAskKind.Folder, path: cache, access: FolderAccess.ReadWrite }
        const pending = broker.request(asking('toolu_1', ask))
        // Before #510's review, allowing it now granted `documents`, read-write: where the link leads.
        swap(cache, documents)

        const answered = broker.answer(pending.request.id, allow)

        expect(answered).toMatchObject({
          state: PermissionRequestState.Denied,
          denyNote: FOLDER_MOVED_NOTE,
          grantedScope: null,
          sandbox: ask,
        })
        expect(granted(taskTarget())).toEqual([])
        expect(granted(workspaceTarget())).toEqual([])
        // The call that waited is told it was denied, and why.
        await expect(pending.decision).resolves.toEqual({ kind: PermissionDecisionKind.Deny, note: FOLDER_MOVED_NOTE })
        expect(broker.isWaiting(pending.request.id)).toBe(false)
      },
    )

    it('refuses when a folder above it was swapped, or it can’t be resolved any more', () => {
      const above = broker.request(
        asking('toolu_1', { kind: SandboxAskKind.Folder, path: cache, access: FolderAccess.Read }),
      )
      swap(join(scratch, 'scratch'), documents)
      expect(broker.answer(above.request.id, FOR_TASK).denyNote).toBe(FOLDER_MOVED_NOTE)

      const loop = join(scratch, 'loop')
      const looping = broker.request(
        asking('toolu_2', { kind: SandboxAskKind.Folder, path: loop, access: FolderAccess.Read }),
      )
      symlinkSync(join(scratch, 'pool'), loop)
      symlinkSync(loop, join(scratch, 'pool'))
      expect(broker.answer(looping.request.id, FOR_WORKSPACE).denyNote).toBe(FOLDER_MOVED_NOTE)
      expect(granted(taskTarget())).toEqual([])
      expect(granted(workspaceTarget())).toEqual([])
    })

    it('grants the folder as its card showed it when it hasn’t moved, and your own denial keeps your note', () => {
      const ask: SandboxAsk = { kind: SandboxAskKind.Folder, path: cache, access: FolderAccess.ReadWrite }
      const allowed = broker.request(asking('toolu_1', ask))
      const denied = broker.request(asking('toolu_2', ask))

      expect(broker.answer(allowed.request.id, FOR_TASK).state).toBe(PermissionRequestState.Allowed)
      expect(granted(taskTarget())).toEqual([
        { kind: SandboxGrantKind.Folder, path: cache, access: FolderAccess.ReadWrite },
      ])
      // Denying a folder that has moved is your denial, as you gave it.
      swap(cache, documents)
      expect(broker.answer(denied.request.id, { kind: PermissionDecisionKind.Deny, note: 'No.' }).denyNote).toBe('No.')
    })

    it('grants a single file as a single file, and refuses one swapped for a link', () => {
      const gitconfig = join(scratch, '.gitconfig')
      writeFileSync(gitconfig, '[user]\n')
      const ask: SandboxAsk = { kind: SandboxAskKind.Folder, path: gitconfig, access: FolderAccess.Read, file: true }
      const first = broker.request(asking('toolu_1', ask))
      const second = broker.request(asking('toolu_2', { ...ask, access: FolderAccess.ReadWrite }))

      broker.answer(first.request.id, FOR_WORKSPACE)
      expect(granted(workspaceTarget())).toEqual([
        { kind: SandboxGrantKind.Folder, path: gitconfig, access: FolderAccess.Read, file: true },
      ])

      swap(gitconfig, join(documents, 'secrets.txt'))
      expect(broker.answer(second.request.id, FOR_WORKSPACE).denyNote).toBe(FOLDER_MOVED_NOTE)
      expect(granted(workspaceTarget())).toEqual([
        { kind: SandboxGrantKind.Folder, path: gitconfig, access: FolderAccess.Read, file: true },
      ])
    })
  })

  it('names the tasks a card grants to', () => {
    expect(cardGrantTarget(SandboxGrantScope.Task, task)).toEqual(taskTarget())
    expect(cardGrantTarget(SandboxGrantScope.Workspace, task)).toEqual(workspaceTarget())
  })

  it('notifies a sandbox request by what it asks for', () => {
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: '' })
    setHomeFolder('/Users/me')

    broker.request(asking('toolu_1', FOLDER))
    broker.request(asking('toolu_2', { ...FOLDER, access: FolderAccess.ReadWrite }))
    broker.request(asking('toolu_3', DOMAIN))
    broker.request(asking('toolu_4', OUTSIDE))

    expect(notify.mock.calls.map(([, text]) => text)).toEqual([
      'Wants to read ~/code/acme-web',
      'Wants to write to ~/code/acme-web',
      'Wants to reach registry.npmjs.org',
      'Wants to run outside the sandbox',
    ])
  })
})
