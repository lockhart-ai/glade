// Broadcast (#489): one message to the chosen active tasks that have an agent (`receivesBroadcast`, #675), in every
// workspace. Main decides who of them gets it, as it runs, and each task takes it the way it takes a message from its
// own input bar, through the agent runner (`../agent/runner`): an idle agent starts a turn with it, a busy one gets it
// at the end of its queue (`./deliver`). One task failing stops no other.
import type { Database } from 'better-sqlite3'
import {
  BroadcastDelivery,
  receivesBroadcast,
  type BroadcastOutcome,
  type BroadcastReached,
} from '../../shared/broadcast'
import { MessageSource, TaskState } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { getTask, listTaskIds } from '../db/repositories/tasks'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { deliverMessage } from './deliver'

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

/**
 * Sends the message to one task: started as its next turn, or queued while its agent is busy (mid-turn, paused, or
 * waiting on your answers or your OK). Throws what the runner throws for a task that can't take it.
 */
function deliver(runner: BroadcastContext['runner'], taskId: string, text: string): BroadcastReached['delivery'] {
  return deliverMessage(runner, taskId, text, MessageSource.Broadcast) === 'sent'
    ? BroadcastDelivery.Sent
    : BroadcastDelivery.Queued
}

/** The chosen tasks a broadcast reaches now: active ones with an agent (`receivesBroadcast`), of `taskIds`. */
function recipients(db: Database, taskIds: readonly string[]): string[] {
  const chosen = new Set(taskIds)
  return listTaskIds(db, null, TaskState.Active).filter((taskId) => {
    if (!chosen.has(taskId)) return false
    const task = getTask(db, taskId)
    return task !== undefined && receivesBroadcast(task)
  })
}

/**
 * Sends `text` to the chosen tasks a broadcast reaches now (`receivesBroadcast`): active ones, in every workspace,
 * but for a task that has never been given anything, and only those of `taskIds` (#675) — the Broadcast modal's
 * ticked ones. A task not among them gets nothing, and a done one gets nothing all the same. Answers with how it went
 * for each task it was sent to, pinned ones first, then the most recently updated; a task that couldn't take it is
 * logged and reported, and the rest still get it.
 */
export function broadcastMessage(
  { db, runner, log = SILENT_LOGGER }: BroadcastContext,
  text: string,
  taskIds: readonly string[],
): BroadcastOutcome[] {
  const message = text.trim()
  const outcomes = recipients(db, taskIds).map((taskId): BroadcastOutcome => {
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
