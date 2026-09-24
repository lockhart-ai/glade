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
