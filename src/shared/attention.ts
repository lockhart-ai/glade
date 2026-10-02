/**
 * What needs your attention (`docs/product.md`, "Attention"): tasks that are unread, and tasks that need you.
 *
 * - **Unread** is a persisted flag (`Task.unread`), set by main when the agent posts a reply in a task you aren't
 *   viewing, and cleared when you open the task (see `src/main/tasks/attention.ts`).
 * - **Needs you** and **working** are derived from the task (`taskAttention`), so they're always right, across
 *   restarts too. One rule drives every place that shows them: the task's dot in the task list and its header, the
 *   workspace switcher's "N needs you", the menu bar's count and lists, Next task that needs you, and the plugin feed.
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

/** What `taskAttention` reads of a task. */
export type AttentionFields = Pick<
  Task,
  'state' | 'activity' | 'sessionId' | 'asking' | 'awaitingPermission' | 'unread' | 'backgroundWork'
>

/** Where a task stands with you. */
export enum TaskAttention {
  /** It's blocked on you, or has a reply you haven't read. */
  NeedsYou = 'needs_you',
  /** Its agent's turn is under way (working or paused), or work it started still runs in the background. */
  Working = 'working',
  /** Neither: nothing is running, and there's nothing new for you. Also every done task. */
  Idle = 'idle',
}

/**
 * Where a task stands with you (#430).
 *
 * It **needs you** when it's blocked on you or has a reply you haven't read: its agent waits on your answers to
 * questions it asked or on your OK for a tool call (whatever its activity says), an error stopped it (a safety check
 * declining it included), or its turn ended and the task is unread. Opening the task reads it, so it no longer needs
 * you; Mark as unread makes it need you again. A brand-new task that has never run never does: it has nothing to show
 * you yet.
 *
 * It's **working** while its agent's turn is under way (a paused turn resumes on its own), and after its turn has ended
 * for as long as background work still runs (`Task.backgroundWork`): a reply that arrives meanwhile marks it unread
 * but doesn't make it need you until that work finishes.
 */
export function taskAttention(task: AttentionFields): TaskAttention {
  if (task.state !== TaskState.Active) return TaskAttention.Idle
  // The agent's turn waits on the answers or the OK, whatever its activity says.
  if (hasRun(task) && (task.asking || task.awaitingPermission)) return TaskAttention.NeedsYou
  switch (task.activity) {
    case TaskActivity.Error:
      return TaskAttention.NeedsYou
    case TaskActivity.Working:
    case TaskActivity.Paused:
      return TaskAttention.Working
    case TaskActivity.Waiting:
      if (task.backgroundWork) return TaskAttention.Working
      return task.unread && hasRun(task) ? TaskAttention.NeedsYou : TaskAttention.Idle
  }
}

/** Whether a task needs you (`taskAttention`). */
export function needsYou(task: AttentionFields): boolean {
  return taskAttention(task) === TaskAttention.NeedsYou
}

/** Whether a task is working, its background work included (`taskAttention`). */
export function isWorking(task: AttentionFields): boolean {
  return taskAttention(task) === TaskAttention.Working
}
