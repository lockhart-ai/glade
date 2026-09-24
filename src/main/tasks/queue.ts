// Every change the user makes to a task's message queue goes through here: adding, editing and removing a message.
// Each writes the queue and tells every window with `queue.changed`. Delivering the queue is the agent runner's job
// (`../agent/runner`), since only it knows when the agent has finished a step.
import { BridgeErrorCode } from '../../shared/bridge'
import type { QueuedMessage } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { emitQueueChanged } from '../bridge/events'
import {
  appendQueuedMessage,
  deleteQueuedMessage,
  getQueuedMessage,
  listQueuedMessages,
  updateQueuedMessage,
} from '../db/repositories/queued-messages'
import { getTask } from '../db/repositories/tasks'
import type { TaskServiceContext } from './service'

/** The queued message, or a `not_found` failure when it isn't queued: delivered, removed, or never there. */
function queued(context: TaskServiceContext, id: string): QueuedMessage {
  const message = getQueuedMessage(context.db, id)
  if (message === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No queued message ${id}`)
  return message
}

function changed(context: TaskServiceContext, taskId: string): void {
  emitQueueChanged(context.emit, taskId, listQueuedMessages(context.db, taskId))
}

/** Adds the user's message to the end of the task's queue. Fails with `not_found` for no such task. */
export function addQueuedMessage(context: TaskServiceContext, taskId: string, text: string): QueuedMessage {
  if (getTask(context.db, taskId) === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
  const message = appendQueuedMessage(context.db, { taskId, body: text })
  changed(context, taskId)
  return message
}

/** Changes a queued message's text. Fails with `not_found` when it isn't queued. */
export function editQueuedMessage(context: TaskServiceContext, id: string, text: string): QueuedMessage {
  const message = { ...queued(context, id), body: text }
  updateQueuedMessage(context.db, id, text)
  changed(context, message.taskId)
  return message
}

/** Removes a queued message. Fails with `not_found` when it isn't queued. */
export function removeQueuedMessage(context: TaskServiceContext, id: string): void {
  const { taskId } = queued(context, id)
  deleteQueuedMessage(context.db, id)
  changed(context, taskId)
}
