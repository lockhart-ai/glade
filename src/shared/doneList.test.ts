import { describe, expect, it } from 'vitest'
import { TaskFilter } from './attention'
import {
  addDoneCounts,
  compareRecency,
  doneCountsOf,
  doneTotal,
  inDoneList,
  isInDoneSection,
  NO_DONE_TASKS,
  pageOfDone,
} from './doneList'
import { Effort, PermissionMode, TaskActivity, TaskState, type Task } from './domain'

function task(id: string, updatedAt: number, change: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId: 'w1',
    title: id,
    objective: '',
    status: '',
    statusUpdatedAt: null,
    state: TaskState.Done,
    activity: TaskActivity.Waiting,
    pinned: false,
    unread: false,
    model: 'claude-sample-1',
    effort: Effort.Medium,
    permissionMode: PermissionMode.AllowAll,
    createdAt: 1_000,
    updatedAt,
    doneAt: updatedAt,
    sessionId: null,
    contextUsedTokens: 0,
    contextWindowTokens: 200_000,
    error: null,
    retrying: null,
    asking: false,
    awaitingPermission: false,
    pause: null,
    ...change,
  }
}

describe('compareRecency', () => {
  it('puts the more recently updated first, then the lower id by code unit, as SQLite orders them', () => {
    expect(compareRecency({ updatedAt: 2, id: 'b' }, { updatedAt: 1, id: 'a' })).toBeLessThan(0)
    expect(compareRecency({ updatedAt: 1, id: 'a' }, { updatedAt: 1, id: 'b' })).toBeLessThan(0)
    expect(compareRecency({ updatedAt: 1, id: 'b' }, { updatedAt: 1, id: 'a' })).toBeGreaterThan(0)
    // By code unit, "Z" (90) comes before "a" (97), where a locale's collation would put it after.
    expect(compareRecency({ updatedAt: 1, id: 'Z' }, { updatedAt: 1, id: 'a' })).toBeLessThan(0)
    expect(compareRecency({ updatedAt: 1, id: 'a' }, { updatedAt: 1, id: 'a' })).toBe(0)
  })
})

describe('the Done section', () => {
  it('holds done tasks that aren’t pinned, narrowed by the filter chip; none needs you', () => {
    expect(isInDoneSection(task('d', 1))).toBe(true)
    expect(isInDoneSection(task('p', 1, { pinned: true }))).toBe(false)
    expect(isInDoneSection(task('a', 1, { state: TaskState.Active }))).toBe(false)
    expect(inDoneList(task('d', 1), 'w1', TaskFilter.All)).toBe(true)
    expect(inDoneList(task('d', 1), 'w2', TaskFilter.All)).toBe(false)
    expect(inDoneList(task('d', 1), 'w1', TaskFilter.Unread)).toBe(false)
    expect(inDoneList(task('d', 1, { unread: true }), 'w1', TaskFilter.Unread)).toBe(true)
    expect(inDoneList(task('d', 1, { sessionId: 's' }), 'w1', TaskFilter.NeedsYou)).toBe(false)
  })

  it('counts each task it holds, and its unread ones', () => {
    expect(doneCountsOf(task('d', 1))).toEqual({ all: 1, unread: 0 })
    expect(doneCountsOf(task('d', 1, { unread: true }))).toEqual({ all: 1, unread: 1 })
    expect(doneCountsOf(task('p', 1, { pinned: true, unread: true }))).toEqual(NO_DONE_TASKS)
    expect(addDoneCounts({ all: 5, unread: 2 }, { all: 1, unread: 1 })).toEqual({ all: 6, unread: 3 })
    expect(addDoneCounts({ all: 5, unread: 2 }, { all: 1, unread: 1 }, -1)).toEqual({ all: 4, unread: 1 })
  })

  it('shows as many as the chip lets through', () => {
    const counts = { all: 1_200, unread: 30 }

    expect(doneTotal(counts, TaskFilter.All)).toBe(1_200)
    expect(doneTotal(counts, TaskFilter.Unread)).toBe(30)
    expect(doneTotal(counts, TaskFilter.NeedsYou)).toBe(0)
  })
})

describe('pageOfDone', () => {
  const tasks = [
    task('c', 300),
    task('a', 100, { unread: true }),
    task('b', 300, { unread: true }),
    task('pinned', 400, { pinned: true }),
    task('active', 500, { state: TaskState.Active }),
  ]

  it('answers a page of the Done section in order, after the cursor, saying whether more follow', () => {
    const request = { workspaceId: 'w1', filter: TaskFilter.All, after: null, limit: 2 }

    expect(pageOfDone(tasks, request)).toEqual({ tasks: [tasks[2], tasks[0]], hasMore: true })
    expect(pageOfDone(tasks, { ...request, after: { updatedAt: 300, id: 'c' } })).toEqual({
      tasks: [tasks[1]],
      hasMore: false,
    })
    expect(pageOfDone(tasks, { ...request, filter: TaskFilter.Unread, limit: 5 }).tasks).toEqual([tasks[2], tasks[1]])
  })
})
