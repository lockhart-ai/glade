import { TaskActivity, TaskState, type Task } from './domain'

/**
 * What a task's indicator shows: its dot in the task list and the pill in its header. The domain maps a task's
 * lifecycle state onto one of these.
 */
export enum TaskIndicator {
  /** The agent is working (blue). */
  Working = 'working',
  /** The agent is waiting on you (purple). */
  Waiting = 'waiting',
  /** The task is done (slate). */
  Done = 'done',
  /** The agent hit an error (pink). */
  Error = 'error',
}

/** The indicator a task shows: done when it's done, otherwise what its agent is doing. */
export function taskIndicator(task: Pick<Task, 'state' | 'activity'>): TaskIndicator {
  if (task.state === TaskState.Done) return TaskIndicator.Done
  switch (task.activity) {
    case TaskActivity.Waiting:
      return TaskIndicator.Waiting
    // A paused turn is still under way: it resumes on its own (docs/design/html/17-usage-limit.html).
    case TaskActivity.Working:
    case TaskActivity.Paused:
      return TaskIndicator.Working
    case TaskActivity.Error:
      return TaskIndicator.Error
  }
}
