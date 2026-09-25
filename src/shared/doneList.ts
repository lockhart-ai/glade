/**
 * The task list's Done section, which can grow to thousands of tasks, so the window loads it from main a page at a
 * time (`tasks.listDone`) rather than all at once. Everything outside it (active tasks, and pinned ones whatever their
 * state) is loaded whole (`tasks.listActive`), with how many tasks the Done section holds.
 *
 * The Done section is most recently updated first, ties by id: the task list's order. A page starts just after the
 * last task of the page before (keyset pagination), so a task added at the top meanwhile never shifts a page.
 */
import { matchesFilter, TaskFilter } from './attention'
import { TaskState, type EpochMs, type Task } from './domain'

/** How many tasks a page of the Done section holds. */
export const DONE_PAGE_SIZE = 100

/** The most tasks one `tasks.listDone` may ask for. */
export const MAX_DONE_PAGE_SIZE = 1_000

/** Where a task sorts in the task list: most recently updated first, ties by id. */
export interface TaskCursor {
  readonly updatedAt: EpochMs
  readonly id: string
}

/** How many tasks a workspace's Done section holds: all of them, and the unread ones (what the Unread chip counts). */
export interface DoneCounts {
  readonly all: number
  readonly unread: number
}

export const NO_DONE_TASKS: DoneCounts = { all: 0, unread: 0 }

export function cursorOf(task: Pick<Task, 'updatedAt' | 'id'>): TaskCursor {
  return { updatedAt: task.updatedAt, id: task.id }
}

/**
 * Compares two tasks' places in the task list: negative when `a` comes first. Ids compare by code unit, as SQLite's
 * `ORDER BY id` does, so the window and the database always agree on the order.
 */
export function compareRecency(a: TaskCursor, b: TaskCursor): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** Whether a task is in the Done section: done, and not pinned (a pinned task shows under Pinned, whatever its state). */
export function isInDoneSection(task: Pick<Task, 'state' | 'pinned'>): boolean {
  return task.state === TaskState.Done && !task.pinned
}

/** Whether a task shows in a workspace's Done section under a filter chip. */
export function inDoneList(task: Task, workspaceId: string, filter: TaskFilter): boolean {
  return task.workspaceId === workspaceId && isInDoneSection(task) && matchesFilter(task, filter)
}

/** What one task adds to its workspace's `DoneCounts`. */
export function doneCountsOf(task: Pick<Task, 'state' | 'pinned' | 'unread'>): DoneCounts {
  if (!isInDoneSection(task)) return NO_DONE_TASKS
  return { all: 1, unread: task.unread ? 1 : 0 }
}

/** The counts with `change` added (or taken away, with `sign` -1). */
export function addDoneCounts(counts: DoneCounts, change: DoneCounts, sign: 1 | -1 = 1): DoneCounts {
  return { all: counts.all + sign * change.all, unread: counts.unread + sign * change.unread }
}

/** How many tasks the Done section shows under a filter chip. Done tasks never need you. */
export function doneTotal(counts: DoneCounts, filter: TaskFilter): number {
  switch (filter) {
    case TaskFilter.All:
      return counts.all
    case TaskFilter.Unread:
      return counts.unread
    case TaskFilter.NeedsYou:
      return 0
  }
}

/** Which page of a workspace's Done section to load. */
export interface DonePageRequest {
  readonly workspaceId: string
  readonly filter: TaskFilter
  /** The last task of the page before; null for the first page. */
  readonly after: TaskCursor | null
  /** At most how many tasks; `DONE_PAGE_SIZE` in the app. */
  readonly limit: number
}

export interface DonePage {
  /** In the task list's order. */
  readonly tasks: readonly Task[]
  /** Whether more tasks follow the page's last. */
  readonly hasMore: boolean
}

/** A page of the Done section, taken from every task in memory: what main's query answers, for tests' stand-ins. */
export function pageOfDone(tasks: Iterable<Task>, request: DonePageRequest): DonePage {
  const { workspaceId, filter, after, limit } = request
  const listed = [...tasks]
    .filter((task) => inDoneList(task, workspaceId, filter))
    .filter((task) => after === null || compareRecency(task, after) > 0)
    .sort(compareRecency)
  return { tasks: listed.slice(0, limit), hasMore: listed.length > limit }
}
