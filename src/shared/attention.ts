/**
 * What needs your attention (`docs/product.md`, "Attention"): tasks that are unread, and tasks that need you.
 *
 * - **Unread** is a persisted flag (`Task.unread`), set by main when the agent posts a reply in a task you aren't
 *   viewing, and cleared when you open the task (see `src/main/tasks/attention.ts`).
 * - **Needs you** is derived from the task, so it's always right, across restarts too.
 */
import { TaskActivity, TaskState, type Task } from './domain'

/**
 * Whether the task's agent has ever run a turn. A task gets its session id from its first turn's `system/init`, and a
 * first turn that fails before then leaves the task errored, so a brand-new task, which hasn't been given anything to
 * do, has neither.
 */
export function hasRun(task: Pick<Task, 'sessionId' | 'activity'>): boolean {
  return task.sessionId !== null || task.activity === TaskActivity.Error
}

/**
 * Whether a task needs you: it's active and its agent's turn has ended, so it's waiting on you or hit an error, or its
 * agent is waiting on your answers to questions it asked. A brand-new task that has never run doesn't count: it has
 * nothing to show you yet.
 */
export function needsYou(task: Pick<Task, 'state' | 'activity' | 'sessionId' | 'asking'>): boolean {
  if (task.state !== TaskState.Active || !hasRun(task)) return false
  // The agent's turn waits on the answers, whatever its activity says.
  if (task.asking) return true
  switch (task.activity) {
    case TaskActivity.Waiting:
    case TaskActivity.Error:
      return true
    // A paused turn resumes on its own.
    case TaskActivity.Working:
    case TaskActivity.Paused:
      return false
  }
}

/** The task list's filter chips. */
export enum TaskFilter {
  All = 'all',
  NeedsYou = 'needs_you',
  Unread = 'unread',
}

/** The filter a stored value names, or All for anything else (it's unset until you first pick one). */
export function parseTaskFilter(value: string | undefined): TaskFilter {
  return Object.values(TaskFilter).find((filter) => filter === value) ?? TaskFilter.All
}

/** Whether a task shows in the task list under a filter. */
export function matchesFilter(
  task: Pick<Task, 'state' | 'activity' | 'sessionId' | 'asking' | 'unread'>,
  filter: TaskFilter,
): boolean {
  switch (filter) {
    case TaskFilter.All:
      return true
    case TaskFilter.NeedsYou:
      return needsYou(task)
    case TaskFilter.Unread:
      return task.unread
  }
}
