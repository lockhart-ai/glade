/**
 * Broadcast (#489, `docs/product.md`): one message sent to every active task, in every workspace, at once. Main decides
 * who gets it and how (`src/main/tasks/broadcast.ts`), and answers with how it reached each task.
 */

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
