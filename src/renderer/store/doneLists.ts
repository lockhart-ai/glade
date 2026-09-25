/**
 * The store's side of the Done section's paging (see `src/shared/doneList.ts`): which of its tasks the store has
 * loaded, and how many it holds.
 */
import { TaskFilter } from '../../shared/attention'
import {
  addDoneCounts,
  compareRecency,
  cursorOf,
  doneCountsOf,
  NO_DONE_TASKS,
  type DoneCounts,
  type DonePage,
} from '../../shared/doneList'
import type { Task } from '../../shared/domain'
import type { DoneListPages, GladeData } from './state'

/** The key of a workspace's Done section under a filter chip in `doneLists`. */
export function doneListKey(workspaceId: string, filter: TaskFilter): string {
  return `${workspaceId}:${filter}`
}

/**
 * Whether a task of the Done section is in the pages loaded so far: at or above the last one loaded, or anywhere once
 * they're all loaded. None is before the first page loads.
 */
export function isLoaded(task: Pick<Task, 'updatedAt' | 'id'>, pages: DoneListPages | undefined): boolean {
  if (pages === undefined) return false
  if (!pages.hasMore) return true
  return pages.end !== null && compareRecency(cursorOf(task), pages.end) <= 0
}

/** How many tasks a workspace's Done section holds; none for a workspace the store has no counts for yet. */
export function doneCountsFor(state: Pick<GladeData, 'doneCounts'>, workspaceId: string): DoneCounts {
  return state.doneCounts[workspaceId] ?? NO_DONE_TASKS
}

/**
 * Adds tasks loaded from main (a page, or tasks found by id), keeping any the store already has: those came from an
 * event, which is at least as new.
 */
export function withLoadedTasks(state: GladeData, tasks: readonly Task[]): GladeData {
  const added = tasks.filter(({ id }) => !(id in state.tasks))
  if (added.length === 0) return state
  return { ...state, tasks: { ...state.tasks, ...Object.fromEntries(added.map((task) => [task.id, task])) } }
}

/** Records a page of a Done section as loaded: its tasks, and where the loaded pages now end. */
export function withDonePage(state: GladeData, workspaceId: string, filter: TaskFilter, page: DonePage): GladeData {
  const key = doneListKey(workspaceId, filter)
  const last = page.tasks.at(-1)
  const end = last === undefined ? (state.doneLists[key]?.end ?? null) : cursorOf(last)
  return {
    ...withLoadedTasks(state, page.tasks),
    doneLists: { ...state.doneLists, [key]: { end, hasMore: page.hasMore } },
  }
}

/**
 * Keeps a workspace's Done counts current as a task changes from `previous` to `next` (undefined once it's deleted).
 * A task the store didn't have is left out: every task outside the Done section is loaded, so it was already in the
 * section and counted, and changes to it are counted from when it's loaded.
 */
export function withCountedChange(state: GladeData, previous: Task | undefined, next: Task | undefined): GladeData {
  if (previous === undefined) return state
  const change = addDoneCounts(next === undefined ? NO_DONE_TASKS : doneCountsOf(next), doneCountsOf(previous), -1)
  if (change.all === 0 && change.unread === 0) return state
  const counts = addDoneCounts(doneCountsFor(state, previous.workspaceId), change)
  return { ...state, doneCounts: { ...state.doneCounts, [previous.workspaceId]: counts } }
}

/** Forgets a removed workspace's Done counts and pages. */
export function withoutDoneLists(state: GladeData, workspaceId: string): GladeData {
  const keys = new Set(Object.values(TaskFilter).map((filter) => doneListKey(workspaceId, filter)))
  const doneCounts = Object.fromEntries(Object.entries(state.doneCounts).filter(([id]) => id !== workspaceId))
  const doneLists = Object.fromEntries(Object.entries(state.doneLists).filter(([key]) => !keys.has(key)))
  return { ...state, doneCounts, doneLists }
}
