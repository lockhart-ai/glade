import { TaskState, type Task } from './domain'

/**
 * What a task's indicator shows: its dot in the task list and the pill in its header. `taskIndicator` maps a task onto
 * one of these.
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

/**
 * The one place a task's indicator is worked out. A done task shows Done; an active task shows Waiting until the agent
 * runner records whether its agent is working or has hit an error.
 */
export function taskIndicator(task: Task): TaskIndicator {
  switch (task.state) {
    case TaskState.Active:
      return TaskIndicator.Waiting
    case TaskState.Done:
      return TaskIndicator.Done
  }
}
