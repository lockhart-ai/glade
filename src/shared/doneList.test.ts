import { describe, expect, it } from 'vitest'
import {
  addDoneCounts,
  compareRecency,
  doneCountsOf,
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
    backgroundWork: false,
    pause: null,
    importedAt: null,
    todos: null,
    autoCompact: null,
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
  it('holds a workspace’s done tasks that aren’t pinned, read or unread', () => {
    expect(isInDoneSection(task('d', 1))).toBe(true)
    expect(isInDoneSection(task('p', 1, { pinned: true }))).toBe(false)
    expect(isInDoneSection(task('a', 1, { state: TaskState.Active }))).toBe(false)
    expect(inDoneList(task('d', 1), 'w1')).toBe(true)
    expect(inDoneList(task('d', 1), 'w2')).toBe(false)
    expect(inDoneList(task('d', 1, { unread: true }), 'w1')).toBe(true)
    expect(inDoneList(task('p', 1, { pinned: true }), 'w1')).toBe(false)
  })

  it('counts each task it holds', () => {
    expect(doneCountsOf(task('d', 1))).toEqual({ all: 1 })
    expect(doneCountsOf(task('d', 1, { unread: true }))).toEqual({ all: 1 })
    expect(doneCountsOf(task('p', 1, { pinned: true, unread: true }))).toEqual(NO_DONE_TASKS)
    expect(addDoneCounts({ all: 5 }, { all: 1 })).toEqual({ all: 6 })
    expect(addDoneCounts({ all: 5 }, { all: 1 }, -1)).toEqual({ all: 4 })
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
    const request = { workspaceId: 'w1', after: null, limit: 2 }

    expect(pageOfDone(tasks, request)).toEqual({ tasks: [tasks[2], tasks[0]], hasMore: true })
    expect(pageOfDone(tasks, { ...request, after: { updatedAt: 300, id: 'c' } })).toEqual({
      tasks: [tasks[1]],
      hasMore: false,
    })
    expect(pageOfDone(tasks, { ...request, limit: 5 }).tasks).toEqual([tasks[2], tasks[0], tasks[1]])
  })
})
