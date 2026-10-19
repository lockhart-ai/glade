/**
 * Task-to-task messages (#710): one task's agent messaging another with Glade's `message_task` tool. A task may
 * message the other Active tasks in its own workspace only, by id (as `list_other_tasks` gives it); delivery goes
 * through the queue path every message that isn't typed into an input bar goes through (`./deliver`), so an idle
 * task starts its next turn with the message and a busy one gets it at the end of its queue. The sender's id
 * travels with the message (`Message.senderTaskId`), so the receiving agent can reply the same way, and the chat
 * shows the sending task's title with it.
 *
 * A guard stops two tasks from keeping an exchange going on their own: at most `TASK_MESSAGES_PER_HOUR` messages
 * from one task to another in a rolling hour, counted durably from the receiver's chat log and its still-queued
 * messages, with the reason given back to the calling agent. Getting the user's attention is `ask`'s job, not a
 * growing pile of messages between tasks.
 */
import type { Database } from 'better-sqlite3'
import { MessageSource, TaskState, type EpochMs } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { getTask } from '../db/repositories/tasks'
import { getWorkspace } from '../db/repositories/workspaces'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { deliverMessage, type Delivery } from './deliver'

/** How long a task message may be, in characters: a few paragraphs, not a document. */
export const TASK_MESSAGE_MAX = 4_000

/**
 * The guard: how many messages one task may send another in a rolling hour (`TASK_MESSAGE_WINDOW_MS`), counting the
 * ones still queued. At the limit, `message_task` is refused until one ages out of the window.
 */
export const TASK_MESSAGES_PER_HOUR = 5
export const TASK_MESSAGE_WINDOW_MS = 60 * 60 * 1_000

/** Whether the guard trips at `count` messages sent within the window: at the limit or past it, never under it. */
export function taskMessagesExceeded(count: number): boolean {
  return count >= TASK_MESSAGES_PER_HOUR
}

/** How many task messages `sender` has sent `receiver` since `since`, delivered or still queued. */
export function countTaskMessagesFrom(db: Database, receiver: string, sender: string, since: EpochMs): number {
  const count: unknown = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM messages
          WHERE task_id = @receiver AND source = @source AND sender_task_id = @sender AND created_at > @since)
       + (SELECT COUNT(*) FROM queued_messages
          WHERE task_id = @receiver AND source = @source AND sender_task_id = @sender AND created_at > @since)`,
    )
    .pluck()
    .get({ receiver, sender, source: MessageSource.Task, since })
  return typeof count === 'number' ? count : 0
}

/** What sending a task message came to: delivered (`Delivery`), or refused with the reason for the calling agent. */
export enum TaskMessageOutcomeKind {
  Sent = 'sent',
  Refused = 'refused',
}

export interface TaskMessageSent {
  readonly kind: TaskMessageOutcomeKind.Sent
  readonly delivery: Delivery
}

export interface TaskMessageRefused {
  readonly kind: TaskMessageOutcomeKind.Refused
  /** Why the call was refused, in words the agent can act on. */
  readonly reason: string
}

export type TaskMessageOutcome = TaskMessageSent | TaskMessageRefused

/** A refusal, as the outcome's one shape: what `sendTaskMessage` returns and a stub in tests can both make. */
export function refusedTaskMessage(reason: string): TaskMessageRefused {
  return { kind: TaskMessageOutcomeKind.Refused, reason }
}

export interface TaskMessagesContext {
  readonly db: Database
  /** What the message is delivered through, as a broadcast is (`./deliver`). */
  readonly runner: Pick<AgentRunner, 'send' | 'queue'>
  /** Where a send or a refusal is logged, never with the message. Nothing by default. */
  readonly log?: Logger
}

/** What the tool is called with, checked already (`../agent/glade-tools`). */
export interface TaskMessageInput {
  readonly to: string
  readonly message: string
}

/** The sending task, as its title reads in a reason or the sender line: "(not set)" until one is named. */
function titleOf(db: Database, taskId: string): string {
  const title = getTask(db, taskId)?.title ?? ''
  return title === '' ? '(not set)' : `"${title}"`
}

/**
 * The line the receiving agent reads ahead of a task message's text, handed over with the message and never stored
 * or shown in the chat: who sent it, and how to answer. The sending task's title, or "(not set)" when it never
 * named one — and the same when it has since been deleted, so the line stays truthful about the id, which is what
 * a reply needs.
 */
export function senderTaskLine(db: Database, senderTaskId: string): string {
  return (
    `Message from Glade task ${titleOf(db, senderTaskId)} (${senderTaskId}). ` +
    'Reply with message_task and that id if you should.'
  )
}

/**
 * Sends one task's message to another (`../agent/glade-tools`' `message_task`): checks who it's going to, counts
 * the guard, and delivers. Never throws for a refused send — the refusal is the tool's answer — but throws what
 * `deliverMessage` throws if the receiver vanishes between the checks and the send.
 */
export function sendTaskMessage(
  { db, runner, log = SILENT_LOGGER }: TaskMessagesContext,
  fromTaskId: string,
  input: TaskMessageInput,
): TaskMessageOutcome {
  const refuse = (reason: string): TaskMessageOutcome => {
    log.info('task message refused', { from: fromTaskId, to: input.to })
    return refusedTaskMessage(reason)
  }
  if (input.to === fromTaskId) {
    return refuse("That's this task: you can't message yourself. Call list_other_tasks for the other Active tasks.")
  }
  const receiver = getTask(db, input.to)
  if (receiver === undefined) {
    return refuse(`No task ${input.to}. Call list_other_tasks for the ids of the other Active tasks.`)
  }
  if (receiver.state !== TaskState.Active) {
    return refuse(`${input.to} is Done, not Active: you can message only Active tasks.`)
  }
  const sender = getTask(db, fromTaskId)
  const mine = sender === undefined ? undefined : getWorkspace(db, sender.workspaceId)
  const theirs = getWorkspace(db, receiver.workspaceId)
  if (sender === undefined || mine?.id !== theirs?.id) {
    return refuse(
      `${input.to} is in the workspace ${theirs === undefined ? '(unknown)' : `"${theirs.name}"`}, not yours ` +
        `(${mine === undefined ? 'unknown' : `"${mine.name}"`}): you can message only tasks in your own workspace.`,
    )
  }
  const since = Date.now() - TASK_MESSAGE_WINDOW_MS
  const count = countTaskMessagesFrom(db, receiver.id, fromTaskId, since)
  if (taskMessagesExceeded(count)) {
    return refuse(
      `You've sent ${String(count)} messages to ${titleOf(db, receiver.id)} in the last hour — Glade's limit is ` +
        `${String(TASK_MESSAGES_PER_HOUR)} from one task to another in a rolling hour, so the pair can't keep an ` +
        'exchange going on their own. Stop here: ask the user, or wait for one of the messages to age out.',
    )
  }
  const delivery = deliverMessage(runner, receiver.id, input.message, MessageSource.Task, fromTaskId)
  log.info('task message sent', { from: fromTaskId, to: receiver.id, delivery })
  return { kind: TaskMessageOutcomeKind.Sent, delivery }
}
