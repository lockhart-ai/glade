import { describe, expect, it } from 'vitest'
import {
  Effort,
  PauseReason,
  PermissionMode,
  TaskActivity,
  TaskState,
  UNTITLED_TASK_TITLE,
  type Task,
  type Workspace,
} from './domain'
import {
  EMPTY_MENU_BAR_SNAPSHOT,
  isInFlight,
  menuBarIcon,
  menuBarSnapshot,
  NEEDS_YOU_REASON_LABELS,
  NeedsYouReason,
  needsYouReason,
  RECENT_NOTIFICATIONS_SHOWN,
  type MenuBarSnapshot,
  type MenuBarSources,
  type SentNotification,
  type WorkingItem,
} from './menuBar'

const ACME: Workspace = { id: 'w1', name: 'Acme API', rootPath: '/code/acme-api', createdAt: 1, lastOpenedAt: 1 }
const BILLING: Workspace = { id: 'w2', name: 'Billing', rootPath: '/code/billing', createdAt: 2, lastOpenedAt: 2 }

/** A task that has run, in Acme API, waiting on you, unless `overrides` say otherwise. */
function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId: ACME.id,
    title: `Task ${id}`,
    objective: '',
    status: '',
    statusUpdatedAt: null,
    state: TaskState.Active,
    activity: TaskActivity.Waiting,
    pinned: false,
    unread: false,
    model: 'claude-sample-1',
    effort: Effort.Medium,
    permissionMode: PermissionMode.AllowAll,
    createdAt: 1_000,
    updatedAt: 2_000,
    doneAt: null,
    sessionId: `session-${id}`,
    contextUsedTokens: 0,
    contextWindowTokens: 200_000,
    error: null,
    retrying: null,
    asking: false,
    awaitingPermission: false,
    pause: null,
    importedAt: null,
    todos: null,
    autoCompact: null,
    ...overrides,
  }
}

function sent(seq: number, taskId = 't1'): SentNotification {
  return { seq, taskId, title: `Task ${taskId}`, body: `Reply ${String(seq)}`, sentAt: 10_000 + seq }
}

function snapshotOf(tasks: readonly Task[], overrides: Partial<MenuBarSources> = {}): MenuBarSnapshot {
  return menuBarSnapshot({ tasks, workspaces: [ACME, BILLING], turnStartedAt: () => null, recent: [], ...overrides })
}

const PAUSE = { reason: PauseReason.UsageLimit, since: 1_000, resumesAt: 90_000, checks: 0, details: '' }

describe('needsYouReason', () => {
  it.each([
    ['asking you questions', task('t', { asking: true }), NeedsYouReason.Asking],
    [
      'asking, whatever its activity says',
      task('t', { asking: true, activity: TaskActivity.Working }),
      NeedsYouReason.Asking,
    ],
    ['waiting on your OK', task('t', { awaitingPermission: true }), NeedsYouReason.Permission],
    [
      'asking and waiting on your OK: the questions first',
      task('t', { asking: true, awaitingPermission: true }),
      NeedsYouReason.Asking,
    ],
    ['stopped by an error', task('t', { activity: TaskActivity.Error }), NeedsYouReason.Error],
    ['replied, its turn over', task('t'), NeedsYouReason.Reply],
    ['working', task('t', { activity: TaskActivity.Working }), null],
    ['paused', task('t', { activity: TaskActivity.Paused }), null],
    ['done', task('t', { state: TaskState.Done }), null],
    ['done with an error', task('t', { state: TaskState.Done, activity: TaskActivity.Error }), null],
    ['brand new, never run', task('t', { sessionId: null }), null],
  ])('says why a task %s needs you', (_, sample, reason) => {
    expect(needsYouReason(sample)).toBe(reason)
  })

  it('has words for every reason', () => {
    for (const reason of Object.values(NeedsYouReason)) expect(NEEDS_YOU_REASON_LABELS[reason]).not.toBe('')
  })
})

describe('isInFlight', () => {
  it('is true while an active task works or is paused, and never for a done one', () => {
    expect(isInFlight(task('t', { activity: TaskActivity.Working }))).toBe(true)
    expect(isInFlight(task('t', { activity: TaskActivity.Paused }))).toBe(true)
    expect(isInFlight(task('t'))).toBe(false)
    expect(isInFlight(task('t', { activity: TaskActivity.Error }))).toBe(false)
    expect(isInFlight(task('t', { state: TaskState.Done, activity: TaskActivity.Working }))).toBe(false)
  })
})

describe('menuBarSnapshot', () => {
  it('is empty with nothing in flight: no tasks, or only done, new and idle ones', () => {
    expect(snapshotOf([])).toEqual(EMPTY_MENU_BAR_SNAPSHOT)
    expect(snapshotOf([task('done', { state: TaskState.Done }), task('new', { sessionId: null })])).toEqual(
      EMPTY_MENU_BAR_SNAPSHOT,
    )
  })

  it('lists the tasks that need you with why and where, the one that changed last first', () => {
    const snapshot = snapshotOf([
      task('old', { updatedAt: 1_000, asking: true }),
      task('new', { updatedAt: 5_000, workspaceId: BILLING.id, activity: TaskActivity.Error }),
      task('mid', { updatedAt: 3_000, awaitingPermission: true }),
    ])
    expect(snapshot.needsYou).toEqual([
      {
        taskId: 'new',
        title: 'Task new',
        workspaceId: 'w2',
        workspaceName: 'Billing',
        reason: NeedsYouReason.Error,
        since: 5_000,
      },
      {
        taskId: 'mid',
        title: 'Task mid',
        workspaceId: 'w1',
        workspaceName: 'Acme API',
        reason: NeedsYouReason.Permission,
        since: 3_000,
      },
      {
        taskId: 'old',
        title: 'Task old',
        workspaceId: 'w1',
        workspaceName: 'Acme API',
        reason: NeedsYouReason.Asking,
        since: 1_000,
      },
    ])
    expect(snapshot.working).toEqual([])
  })

  it('lists the working tasks with their status, todos and turn start, the one working longest first, unknown starts last', () => {
    const todos = { done: 3, total: 7, doing: ['Run the tests'] }
    const starts: Record<string, number | null> = { a: 5_000, b: 1_000, c: null }
    const snapshot = snapshotOf(
      [
        task('c', { activity: TaskActivity.Working }),
        task('a', { activity: TaskActivity.Working, status: 'Writing the tests', todos, workspaceId: BILLING.id }),
        task('b', { activity: TaskActivity.Working, status: 'Reading the views' }),
      ],
      { turnStartedAt: (taskId) => starts[taskId] ?? null },
    )
    expect(snapshot.working.map(({ taskId }) => taskId)).toEqual(['b', 'a', 'c'])
    expect(snapshot.working[1]).toEqual({
      taskId: 'a',
      title: 'Task a',
      workspaceId: 'w2',
      workspaceName: 'Billing',
      status: 'Writing the tests',
      todos,
      pause: null,
      startedAt: 5_000,
    } satisfies WorkingItem)
    expect(snapshot.needsYou).toEqual([])
  })

  it('keeps the rows in place, by id, when they tie', () => {
    const snapshot = snapshotOf(
      [
        task('z', { activity: TaskActivity.Working }),
        task('y'),
        task('x', { activity: TaskActivity.Working }),
        task('w'),
      ],
      { turnStartedAt: () => 1_000 },
    )
    expect(snapshot.needsYou.map(({ taskId }) => taskId)).toEqual(['w', 'y'])
    expect(snapshot.working.map(({ taskId }) => taskId)).toEqual(['x', 'z'])
  })

  it('lists a paused task under Working with its pause, and a working one never keeps a stale pause', () => {
    const snapshot = snapshotOf([
      task('paused', { activity: TaskActivity.Paused, pause: PAUSE }),
      task('working', { activity: TaskActivity.Working, pause: PAUSE }),
    ])
    expect(snapshot.working.map(({ taskId, pause }) => [taskId, pause])).toEqual([
      ['paused', PAUSE],
      ['working', null],
    ])
  })

  it('names an untitled task as the task list does, and leaves out a task whose workspace is gone', () => {
    const snapshot = snapshotOf([task('untitled', { title: '' }), task('orphan', { workspaceId: 'gone' })])
    expect(snapshot.needsYou.map(({ taskId, title }) => [taskId, title])).toEqual([['untitled', UNTITLED_TASK_TITLE]])
  })

  it('never lists a task twice: one asking while it works needs you, and is not working', () => {
    const snapshot = snapshotOf([task('both', { activity: TaskActivity.Working, awaitingPermission: true })])
    expect(snapshot.needsYou.map(({ taskId }) => taskId)).toEqual(['both'])
    expect(snapshot.working).toEqual([])
  })

  it('keeps the latest notifications, newest first as given, up to how many Recent shows', () => {
    const recent = Array.from({ length: RECENT_NOTIFICATIONS_SHOWN + 3 }, (_, index) => sent(20 - index))
    expect(snapshotOf([], { recent }).recent).toEqual(recent.slice(0, RECENT_NOTIFICATIONS_SHOWN))
    expect(snapshotOf([], { recent: [sent(2), sent(1)] }).recent).toEqual([sent(2), sent(1)])
  })
})

describe('menuBarIcon', () => {
  const working = snapshotOf([task('w', { activity: TaskActivity.Working })])
  const waiting = snapshotOf([task('a'), task('b', { asking: true })])
  const both = snapshotOf([task('w', { activity: TaskActivity.Working }), task('a', { activity: TaskActivity.Error })])

  it('is still and says nothing when nothing is in flight, or only notifications are', () => {
    expect(menuBarIcon(EMPTY_MENU_BAR_SNAPSHOT, false)).toEqual({ title: '', pulse: false })
    expect(menuBarIcon({ ...EMPTY_MENU_BAR_SNAPSHOT, recent: [sent(1)] }, false)).toEqual({ title: '', pulse: false })
  })

  it('pulses while an agent works', () => {
    expect(menuBarIcon(working, false)).toEqual({ title: '', pulse: true })
  })

  it('counts the tasks that need you', () => {
    expect(menuBarIcon(waiting, false)).toEqual({ title: '2', pulse: false })
    expect(menuBarIcon(both, false)).toEqual({ title: '1', pulse: true })
  })

  it('counts as the tasks change: up, down, and to nothing', () => {
    const counts = [[task('a')], [task('a'), task('b')], [task('b')], []].map(
      (tasks) => menuBarIcon(snapshotOf(tasks), false).title,
    )
    expect(counts).toEqual(['1', '2', '1', ''])
  })

  it('holds still with Reduce motion on, still counting', () => {
    expect(menuBarIcon(working, true)).toEqual({ title: '', pulse: false })
    expect(menuBarIcon(both, true)).toEqual({ title: '1', pulse: false })
  })

  it('holds still while every turn under way is paused, and pulses again once one works', () => {
    const paused = task('p', { activity: TaskActivity.Paused, pause: PAUSE })
    expect(menuBarIcon(snapshotOf([paused]), false)).toEqual({ title: '', pulse: false })
    expect(menuBarIcon(snapshotOf([paused, task('w', { activity: TaskActivity.Working })]), false).pulse).toBe(true)
  })
})
