import { TaskAttention, taskAttention, type AttentionFields } from './attention'
import { TaskActivity, TaskState } from './domain'

/**
 * What a task's indicator shows: its dot in the task list and the pill in its header. The domain maps a task's
 * lifecycle state onto one of these.
 */
export enum TaskIndicator {
  /** The agent is working, or work it started still runs in the background (blue). */
  Working = 'working',
  /** The task needs you: a question, a permission card, or a reply you haven't read (purple). */
  Waiting = 'waiting',
  /** The task is active with nothing running and nothing new for you (slate). */
  Idle = 'idle',
  /** The task is done (slate). */
  Done = 'done',
  /** The agent hit an error (pink). */
  Error = 'error',
}

/**
 * The indicator a task shows: done when it's done, an error while one has stopped its agent, otherwise where it stands
 * with you (`taskAttention`): needing you, working (a paused turn is still under way: it resumes on its own,
 * docs/design/html/17-usage-limit.html), or idle.
 */
export function taskIndicator(task: AttentionFields): TaskIndicator {
  if (task.state === TaskState.Done) return TaskIndicator.Done
  if (task.activity === TaskActivity.Error) return TaskIndicator.Error
  switch (taskAttention(task)) {
    case TaskAttention.NeedsYou:
      return TaskIndicator.Waiting
    case TaskAttention.Working:
      return TaskIndicator.Working
    case TaskAttention.Idle:
      return TaskIndicator.Idle
  }
}
