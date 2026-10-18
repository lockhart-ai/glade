/**
 * The queue path every message that isn't typed into a task's own input bar goes through (Broadcast, #489; the GitHub
 * link watcher, #682): started as the task's next turn when its agent is idle, or queued at the end of its own queue
 * while it's busy (mid-turn, paused, or waiting on your answers or your OK). One task's turn down this path never
 * waits for another's: each call is independent, so the caller decides whether one failing stops the rest.
 */
import { BridgeErrorCode } from '../../shared/bridge'
import type { MessageSource } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { CommandFailure } from '../bridge/errors'

/** Whether the runner refused a send because the task's agent is busy, so the message is to be queued instead. */
function isBusy(error: unknown): boolean {
  return error instanceof CommandFailure && error.code === BridgeErrorCode.Busy
}

/** Where the message landed: started as a turn, or waiting at the end of the task's queue. */
export type Delivery = 'sent' | 'queued'

/**
 * Sends `text` to `taskId` with `source` tagging it (never your own words), through the runner's own `send`/`queue`
 * path: started as its next turn when idle, or queued when its agent is busy. Throws what the runner throws for a
 * task that can't take it at all (`not_found`, or a reason `queue` itself refuses for).
 */
export function deliverMessage(
  runner: Pick<AgentRunner, 'send' | 'queue'>,
  taskId: string,
  text: string,
  source: MessageSource,
): Delivery {
  try {
    runner.send(taskId, text, [], [], [], source)
    return 'sent'
  } catch (error) {
    if (!isBusy(error)) throw error
  }
  runner.queue(taskId, text, [], [], [], source)
  return 'queued'
}
