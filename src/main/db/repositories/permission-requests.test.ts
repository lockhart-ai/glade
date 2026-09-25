import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PermissionDestination,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  type Task,
} from '../../../shared/domain'
import {
  appendPermissionRequest,
  closePermissionRequest,
  getPermissionRequest,
  listAllOpenPermissionRequests,
  listOpenPermissionRequests,
  listPermissionRequests,
  listRestartRequests,
  listTasksWithRestartRequests,
  restartDeliveryOf,
  RestartDelivery,
  setRestartDelivery,
  type NewPermissionRequest,
} from './permission-requests'
import { RowError } from './rows'
import { getTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

/** A subagent's `Bash` call, with everything the SDK can say about it. */
function subagentBash(): NewPermissionRequest {
  return {
    taskId: task.id,
    turn: 2,
    toolUseId: 'toolu_01',
    agentId: 'ac2cfaf3cec2364e5',
    toolName: 'Bash',
    input: { command: 'npm test', description: 'Run the test suite' },
    title: 'Claude wants to run npm test',
    displayName: 'Bash',
    description: 'Run the test suite',
    suggestions: [
      {
        type: PermissionUpdateType.AddRules,
        rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
        behavior: PermissionRuleBehavior.Allow,
        destination: PermissionDestination.LocalSettings,
      },
      {
        type: PermissionUpdateType.AddDirectories,
        directories: ['/code/acme-api'],
        destination: PermissionDestination.Session,
      },
    ],
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
  }
}

describe('permission requests', () => {
  it('opens a request and reads it back as it was, the task awaiting permission while it is open', () => {
    const request = appendPermissionRequest(test.db, subagentBash(), 3_000)

    expect(request).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      ...subagentBash(),
      state: PermissionRequestState.Open,
      denyNote: null,
      grantedRule: null,
      createdAt: 3_000,
      closedAt: null,
    })
    expect(getPermissionRequest(test.db, request.id)).toEqual(request)
    expect(getTask(test.db, task.id)?.awaitingPermission).toBe(true)
  })

  it('keeps the bare facts of a plain call', () => {
    const request = appendPermissionRequest(test.db, {
      ...subagentBash(),
      agentId: null,
      title: null,
      displayName: null,
      description: null,
      suggestions: [],
      defaultToNo: false,
      suppressAlwaysAllowRule: false,
    })
    expect(getPermissionRequest(test.db, request.id)).toEqual(request)
  })

  it('closes an open request once, as allowed, denied with a note, or withdrawn', () => {
    const allowed = appendPermissionRequest(test.db, subagentBash(), 1)
    const denied = appendPermissionRequest(test.db, subagentBash(), 2)
    const withdrawn = appendPermissionRequest(test.db, subagentBash(), 3)

    expect(closePermissionRequest(test.db, allowed.id, { state: PermissionRequestState.Allowed }, 10)).toMatchObject({
      state: PermissionRequestState.Allowed,
      denyNote: null,
      closedAt: 10,
    })
    expect(
      closePermissionRequest(test.db, denied.id, { state: PermissionRequestState.Denied, note: 'Use pnpm.' }, 11),
    ).toMatchObject({ state: PermissionRequestState.Denied, denyNote: 'Use pnpm.', closedAt: 11 })
    expect(closePermissionRequest(test.db, withdrawn.id, { state: PermissionRequestState.Withdrawn })).toMatchObject({
      state: PermissionRequestState.Withdrawn,
    })

    expect(closePermissionRequest(test.db, allowed.id, { state: PermissionRequestState.Withdrawn })).toBeUndefined()
    expect(closePermissionRequest(test.db, 'missing', { state: PermissionRequestState.Allowed })).toBeUndefined()
    expect(getPermissionRequest(test.db, allowed.id)?.state).toBe(PermissionRequestState.Allowed)
    expect(getTask(test.db, task.id)?.awaitingPermission).toBe(false)
  })

  it("lists a task's requests in the order they were made, and its open ones", () => {
    const other = sampleTask(test.db, task.workspaceId)
    const first = appendPermissionRequest(test.db, subagentBash(), 1)
    const second = appendPermissionRequest(test.db, subagentBash(), 1)
    appendPermissionRequest(test.db, { ...subagentBash(), taskId: other.id }, 1)
    closePermissionRequest(test.db, first.id, { state: PermissionRequestState.Allowed })

    expect(listPermissionRequests(test.db, task.id).map(({ id }) => id)).toEqual([first.id, second.id])
    expect(listOpenPermissionRequests(test.db, task.id).map(({ id }) => id)).toEqual([second.id])
    expect(getPermissionRequest(test.db, 'missing')).toBeUndefined()
  })

  it('refuses a row whose suggestions are not ones it knows', () => {
    const request = appendPermissionRequest(test.db, subagentBash())
    test.db
      .prepare(`UPDATE permission_requests SET suggestions = '[{"type":"grantEverything"}]' WHERE id = ?`)
      .run(request.id)

    expect(() => getPermissionRequest(test.db, request.id)).toThrow(RowError)
  })

  it('keeps the rule a request was allowed for the task with, and none for any other answer', () => {
    const forTask = appendPermissionRequest(test.db, subagentBash(), 1)
    const denied = appendPermissionRequest(test.db, subagentBash(), 2)
    const rule = { toolName: 'Bash', ruleContent: 'npm test *' }

    expect(
      closePermissionRequest(test.db, forTask.id, { state: PermissionRequestState.Allowed, grantedRule: rule }, 10),
    ).toMatchObject({ state: PermissionRequestState.Allowed, grantedRule: rule, closedAt: 10 })
    expect(getPermissionRequest(test.db, forTask.id)?.grantedRule).toEqual(rule)
    expect(
      closePermissionRequest(test.db, denied.id, { state: PermissionRequestState.Denied, note: null }),
    ).toMatchObject({ grantedRule: null })
    // A whole tool's rule, with no content.
    const edit = appendPermissionRequest(test.db, { ...subagentBash(), toolName: 'Edit' }, 3)
    closePermissionRequest(test.db, edit.id, {
      state: PermissionRequestState.Allowed,
      grantedRule: { toolName: 'Edit' },
    })
    expect(getPermissionRequest(test.db, edit.id)?.grantedRule).toEqual({ toolName: 'Edit' })
  })

  it('refuses a row whose granted rule is not a rule', () => {
    const request = appendPermissionRequest(test.db, subagentBash())
    test.db.prepare(`UPDATE permission_requests SET granted_rule = '{"ruleContent":"x"}' WHERE id = ?`).run(request.id)

    expect(() => getPermissionRequest(test.db, request.id)).toThrow(RowError)
    expect(() =>
      test.db.prepare(`UPDATE permission_requests SET granted_rule = '[]' WHERE id = ?`).run(request.id),
    ).toThrow(/CHECK/)
  })
})

describe('requests the app quit on', () => {
  it('lists the open requests of every task, and records how far each has got', () => {
    const other = sampleTask(test.db, task.workspaceId, 1_000)
    const first = appendPermissionRequest(test.db, subagentBash(), 10)
    const second = appendPermissionRequest(test.db, { ...subagentBash(), taskId: other.id, toolUseId: 'toolu_02' }, 20)
    const closed = appendPermissionRequest(test.db, { ...subagentBash(), toolUseId: 'toolu_03' }, 30)
    closePermissionRequest(test.db, closed.id, { state: PermissionRequestState.Withdrawn })

    expect(listAllOpenPermissionRequests(test.db).map(({ id }) => id)).toEqual([first.id, second.id])
    expect(restartDeliveryOf(test.db, first.id)).toBeNull()
    expect(restartDeliveryOf(test.db, 'missing')).toBeNull()
    expect(listTasksWithRestartRequests(test.db, RestartDelivery.Pending)).toEqual([])

    setRestartDelivery(test.db, [first.id, second.id], RestartDelivery.Pending)
    setRestartDelivery(test.db, [closed.id], RestartDelivery.Delivered)

    expect(restartDeliveryOf(test.db, first.id)).toBe(RestartDelivery.Pending)
    // Oldest task first.
    expect(listTasksWithRestartRequests(test.db, RestartDelivery.Pending)).toEqual([other.id, task.id])
    expect(listRestartRequests(test.db, task.id, RestartDelivery.Pending).map(({ id }) => id)).toEqual([first.id])
    expect(listRestartRequests(test.db, task.id, RestartDelivery.Delivered).map(({ id }) => id)).toEqual([closed.id])
    expect(listRestartRequests(test.db, task.id, RestartDelivery.Settled)).toEqual([])
  })

  it('refuses a stage it doesn’t know', () => {
    const request = appendPermissionRequest(test.db, subagentBash())
    test.db.pragma('ignore_check_constraints = ON')
    test.db.prepare("UPDATE permission_requests SET restart_delivery = 'lost'").run()

    expect(() => restartDeliveryOf(test.db, request.id)).toThrow(RowError)
  })
})
