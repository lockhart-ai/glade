import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import {
  PermissionDecisionKind,
  PermissionRequestState,
  TaskActivity,
  UiStateKey,
  type Task,
} from '../../shared/domain'
import type { NewPermissionRequest } from '../db/repositories/permission-requests'
import { getPermissionRequest, listPermissionRequests } from '../db/repositories/permission-requests'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { createPermissionBroker, type PermissionBroker } from './permissions'

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
