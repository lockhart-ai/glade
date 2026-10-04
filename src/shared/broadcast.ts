/**
 * Broadcast (#489, `docs/product.md`): one message sent to every active task that has an agent, in every workspace, at
 * once. Main decides who gets it and how (`src/main/tasks/broadcast.ts`), and answers with how it reached each task.
 */
import { hasRun } from './attention'
import { TaskActivity, TaskState, type Task } from './domain'

/** What `receivesBroadcast` reads of a task. */
export type BroadcastFields = Pick<Task, 'state' | 'activity' | 'sessionId'>

/**
 * Whether a broadcast reaches a task: it's active, and it has an agent. A task that has never been given anything has
 * none (no session, nothing running, no error), so it can't be the one doing something on the machine, and a
 * broadcast would only start one for nothing: it gets nothing, and isn't listed. A task whose first turn is under way
 * has an agent though its session isn't known yet, and one an error stopped has run (`hasRun`): both get it. Main's
 * delivery and the modal's list and count both ask this, so the count is who receives it.
 */
export function receivesBroadcast(task: BroadcastFields): boolean {
  if (task.state !== TaskState.Active) return false
  return hasRun(task) || task.activity !== TaskActivity.Waiting
}

/** How a broadcast reached a task. */
export enum BroadcastDelivery {
  /** The task's agent was idle: the message started a turn. */
  Sent = 'sent',
  /** The task's agent was busy (mid-turn, paused, or waiting on your answers or your OK): the message is queued. */
  Queued = 'queued',
  /** The task couldn't take it: nothing was saved to it. */
  Failed = 'failed',
}

/** A task the broadcast reached. */
export interface BroadcastReached {
  readonly taskId: string
  readonly delivery: BroadcastDelivery.Sent | BroadcastDelivery.Queued
}

/** A task the broadcast didn't reach, and why. */
export interface BroadcastFailed {
  readonly taskId: string
  readonly delivery: BroadcastDelivery.Failed
  /** Why, as a failed send says it. */
  readonly message: string
}

/** How a broadcast went for one task. */
export type BroadcastOutcome = BroadcastReached | BroadcastFailed
