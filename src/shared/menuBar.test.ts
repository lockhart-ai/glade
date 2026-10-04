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

/** A task that has run, in Acme API, with a reply you haven't read, unless `overrides` say otherwise. */
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
    unread: true,
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
    permissionAsk: null,
    backgroundWork: false,
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
    ['with a reply you have not read', task('t'), NeedsYouReason.Reply],
    [
      'stopped by an error you have seen',
      task('t', { activity: TaskActivity.Error, unread: false }),
      NeedsYouReason.Error,
    ],
    ['asking, the task read', task('t', { asking: true, unread: false }), NeedsYouReason.Asking],
    ['with a reply you have read', task('t', { unread: false }), null],
    ['with an unread reply, its subagents still running', task('t', { backgroundWork: true }), NeedsYouReason.Reply],
    ['with a read reply, its subagents still running', task('t', { backgroundWork: true, unread: false }), null],
    [
      'asking while its subagents run',
      task('t', { backgroundWork: true, unread: false, asking: true }),
      NeedsYouReason.Asking,
    ],
    ['working', task('t', { activity: TaskActivity.Working }), null],
    ['paused', task('t', { activity: TaskActivity.Paused }), null],
    ['done', task('t', { state: TaskState.Done }), null],
    ['done with an error', task('t', { state: TaskState.Done, activity: TaskActivity.Error }), null],
    ['brand new, never run', task('t', { sessionId: null }), null],
  ])('says why a task %s needs you', (_, sample, reason) => {
    expect(needsYouReason(sample)).toBe(reason)
  })

  it('has words for every reason, and calls a reply what it is: unread', () => {
    for (const reason of Object.values(NeedsYouReason)) expect(NEEDS_YOU_REASON_LABELS[reason]).not.toBe('')
    expect(NEEDS_YOU_REASON_LABELS[NeedsYouReason.Reply]).toBe('Unread reply')
  })
})

describe('menuBarSnapshot', () => {
  it('is empty with nothing in flight: no tasks, or only done, new and idle ones', () => {
    expect(snapshotOf([])).toEqual(EMPTY_MENU_BAR_SNAPSHOT)
    expect(
      snapshotOf([
        task('done', { state: TaskState.Done }),
        task('new', { sessionId: null }),
        task('read', { unread: false }),
      ]),
    ).toEqual(EMPTY_MENU_BAR_SNAPSHOT)
  })

  it('lists a task whose turn ended under Working while its background work runs, only once its reply is read', () => {
    const snapshot = snapshotOf(
      [
        task('read', { unread: false, backgroundWork: true, status: 'Waiting on two subagents', pause: PAUSE }),
        task('unread', { backgroundWork: true }),
      ],
      { turnStartedAt: (taskId) => (taskId === 'read' ? 4_000 : null) },
    )
    // The unread one needs you though its subagents still run (#461); only the read one is working.
    expect(snapshot.needsYou.map(({ taskId, reason }) => [taskId, reason])).toEqual([['unread', NeedsYouReason.Reply]])
    expect(snapshot.working).toEqual([
      {
        taskId: 'read',
        title: 'Task read',
        workspaceId: 'w1',
        workspaceName: 'Acme API',
        status: 'Waiting on two subagents',
        todos: null,
        pause: null,
        startedAt: 4_000,
      },
    ] satisfies WorkingItem[])
  })

  it('needs you for an unread reply, a question or an error while background work runs, and once it ends on a read reply', () => {
    const running = task('t', { backgroundWork: true })
    // Unread with background work still running already needs you (#461).
    expect(snapshotOf([running]).needsYou.map(({ reason }) => reason)).toEqual([NeedsYouReason.Reply])
    expect(snapshotOf([{ ...running, asking: true }]).needsYou.map(({ reason }) => reason)).toEqual([
      NeedsYouReason.Asking,
    ])
    expect(snapshotOf([{ ...running, activity: TaskActivity.Error }]).needsYou.map(({ reason }) => reason)).toEqual([
      NeedsYouReason.Error,
    ])
    // Read, with background work still running: working, not needing you.
    expect(snapshotOf([{ ...running, unread: false }]).working.map(({ taskId }) => taskId)).toEqual(['t'])
    // Read, and nothing left running: in neither list.
    expect(snapshotOf([{ ...running, backgroundWork: false, unread: false }])).toEqual(EMPTY_MENU_BAR_SNAPSHOT)
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

  it('says nothing when nothing needs you, or only notifications are', () => {
    expect(menuBarIcon(EMPTY_MENU_BAR_SNAPSHOT)).toEqual({ title: '' })
    expect(menuBarIcon({ ...EMPTY_MENU_BAR_SNAPSHOT, recent: [sent(1)] })).toEqual({ title: '' })
  })

  it('says nothing while agents work, or wait paused: only what needs you shows', () => {
    const paused = task('p', { activity: TaskActivity.Paused, pause: PAUSE })
    expect(menuBarIcon(working)).toEqual({ title: '' })
    expect(menuBarIcon(snapshotOf([paused]))).toEqual({ title: '' })
  })

  it('counts the tasks that need you, whatever else is working', () => {
    expect(menuBarIcon(waiting)).toEqual({ title: '2' })
    expect(menuBarIcon(both)).toEqual({ title: '1' })
  })

  it('leaves out replies you have read, and a read reply still working in the background, but counts an unread one working in the background too', () => {
    const tasks = [
      task('read', { unread: false }),
      task('read-bg', { unread: false, backgroundWork: true }),
      task('bg', { backgroundWork: true }),
      task('unread'),
    ]
    expect(menuBarIcon(snapshotOf(tasks))).toEqual({ title: '2' })
  })

  it('counts as the tasks change: up, down, and to nothing', () => {
    const counts = [[task('a')], [task('a'), task('b')], [task('b')], []].map(
      (tasks) => menuBarIcon(snapshotOf(tasks)).title,
    )
    expect(counts).toEqual(['1', '2', '1', ''])
  })
})
