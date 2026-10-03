// Broadcast (#489): one message to every active task, in every workspace. Main decides who gets it, as it runs, and
// each task takes it the way it takes a message from its own input bar, through the agent runner (`../agent/runner`):
// an idle agent starts a turn with it, a busy one gets it at the end of its queue. One task failing stops no other.
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import { BroadcastDelivery, type BroadcastOutcome, type BroadcastReached } from '../../shared/broadcast'
import { TaskState } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { CommandFailure } from '../bridge/errors'
import { listTaskIds } from '../db/repositories/tasks'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

export interface BroadcastContext {
  readonly db: Database
  /** What the message is sent through, as the input bar's messages are. */
  readonly runner: Pick<AgentRunner, 'send' | 'queue'>
  /** Where a task that couldn't take the message is logged, never with the message. Nothing by default. */
  readonly log?: Logger
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether the runner refused a send because the task's agent is busy, so the message is to be queued instead. */
function isBusy(error: unknown): boolean {
  return error instanceof CommandFailure && error.code === BridgeErrorCode.Busy
}

/**
 * Sends the message to one task: started as its next turn, or queued while its agent is busy (mid-turn, paused, or
 * waiting on your answers or your OK). Throws what the runner throws for a task that can't take it.
 */
function deliver(runner: BroadcastContext['runner'], taskId: string, text: string): BroadcastReached['delivery'] {
  try {
    runner.send(taskId, text, [], [], [], true)
    return BroadcastDelivery.Sent
  } catch (error) {
    if (!isBusy(error)) throw error
  }
  runner.queue(taskId, text, [], [], [], true)
  return BroadcastDelivery.Queued
}

/**
 * Sends `text` to every task that's active now, in every workspace: the pinned ones first, then the most recently
 * updated. Done tasks get nothing. Answers with how it went for each task, in that order; a task that couldn't take it
 * is logged and reported, and the rest still get it.
 */
export function broadcastMessage(
  { db, runner, log = SILENT_LOGGER }: BroadcastContext,
  text: string,
): BroadcastOutcome[] {
  const message = text.trim()
  const outcomes = listTaskIds(db, null, TaskState.Active).map((taskId): BroadcastOutcome => {
    try {
      return { taskId, delivery: deliver(runner, taskId, message) }
    } catch (error) {
      log.with({ taskId }).warn('broadcast not delivered', { error: describe(error) })
      return { taskId, delivery: BroadcastDelivery.Failed, message: describe(error) }
    }
  })
  const count = (delivery: BroadcastDelivery): number =>
    outcomes.filter((outcome) => outcome.delivery === delivery).length
  log.info('broadcast sent', {
    tasks: outcomes.length,
    sent: count(BroadcastDelivery.Sent),
    queued: count(BroadcastDelivery.Queued),
    failed: count(BroadcastDelivery.Failed),
  })
  return outcomes
}
