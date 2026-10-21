/**
 * The agent's questions (`ask`, `docs/model-surface.md`), from the call that asks them to the answer it waits on.
 *
 * - **Asking** saves an open question set for the task (so it outlives the app), tells the windows (`question.opened`)
 *   and waits, however long it takes, until the set is answered or withdrawn. The task's agent is waiting on you while
 *   it does, though its turn is still running: its activity is waiting, and `task.asking` is true. Questions in a task
 *   you aren't viewing mark it unread and are notified, as a final reply is (`../tasks/attention`): the notification
 *   says the first line of the agent's preamble, or with none, the first question.
 * - **Answering** closes the set with your reply (`question.answered`), and the call that waits on it returns it; the
 *   task is working again.
 * - **Withdrawing** closes the set without one (`question.withdrawn`), when the turn that asked it ends some other way:
 *   it was stopped, or it failed. The call that waits on it returns nothing.
 * - **Parking** (`park`, #759) ends the waiting call without closing the set: a GitHub notice for a task blocked in
 *   `ask` ends the call saying the user hasn't answered, the card stays open for them, and their later answer reaches
 *   the agent the way one for a question the app quit on does — as a message.
 *
 * Only this process's calls wait: a set still open from before the app quit has nothing waiting on it (`isWaiting` is
 * false), and the agent runner hands its answer to the agent another way.
 */
import { BridgeErrorCode } from '../../shared/bridge'
import {
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  type Question,
  type QuestionReply,
  type QuestionSet,
} from '../../shared/domain'
import { agentText } from '../../shared/pastedContent'
import { withAttachedFiles } from '../../shared/attachedFiles'
import { answersResult } from '../../shared/questions'
import { CommandFailure } from '../bridge/errors'
import { emitQuestionSet, emitTaskUpdated } from '../bridge/events'
import { lastTurn } from '../db/repositories/messages'
import { getImage } from '../db/repositories/images'
import type { Database } from 'better-sqlite3'
import type { ImageData } from '../../shared/images'
import {
  appendQuestionSet,
  closeQuestionSet,
  getOpenQuestionSet,
  getQuestionSet,
  type QuestionSetClosing,
} from '../db/repositories/question-sets'
import { getTask } from '../db/repositories/tasks'
import { plainText, type NotifyReply } from '../notifications/notifications'
import { noteAgentReply } from '../tasks/attention'
import { updateTaskFromRunner, type TaskServiceContext } from '../tasks/service'

/** What one `ask` call asks: its questions, and what the agent says before them, if anything. */
export interface Asking {
  /** The agent's reply to your message, in Markdown, shown at the top of the card. */
  readonly preamble?: string | undefined
  readonly questions: readonly Question[]
}

/**
 * What a parked `ask` call resolves with (`park`, #759): the user hasn't answered, so the call ends saying so while the
 * set stays open for them. Neither a reply nor `null`, which would answer or withdraw.
 */
export const ASK_PARKED = Symbol('ask parked')

export interface QuestionBroker {
  /**
   * Opens a question set for the task and waits on it. Resolves with your reply once it's answered, null once it's
   * withdrawn, or `signal` aborts (the SDK cancelled the call), which withdraws it, or `ASK_PARKED` once another call
   * parked it (`park`).
   */
  ask(taskId: string, asking: Asking, signal?: AbortSignal): Promise<QuestionReply | null | typeof ASK_PARKED>
  /** Whether a call in this process is waiting on the set. */
  isWaiting(id: string): boolean
  /**
   * Ends the call waiting on the task's open question set with `ASK_PARKED`, without answering or withdrawing it
   * (#759): the set stays open for the user, and their later answer reaches the agent the way one for a question the
   * app quit on does, as a message. Answers whether a call was parked: false when no call waits, or on no open set.
   */
  park(taskId: string): boolean
  /**
   * Answers an open question set with your reply, which the call waiting on it returns. Answers with the set as it now
   * is. Throws a `CommandFailure`: `not_found` for no such set, `invalid_transition` for one that isn't open.
   */
  answer(id: string, reply: QuestionReply): QuestionSet
  /** Withdraws the task's open question set, if it has one. */
  withdraw(taskId: string): void
  /**
   * Lets go of the calls waiting, as the app quits: their sets stay open, for the next launch to find, even as the
   * sessions closing cancel the calls.
   */
  close(): void
}

/**
 * What the `ask` tool gives the model for a reply: the answers keyed by question index, with `anythingElse` when the
 * card's "Anything else?" box has text, or `{ freeText }`. A free-text reply's text carries its pasted text and its
 * attached files' lines the way a message does (`shared/pastedContent.ts`, `shared/attachedFiles.ts`); the images
 * don't show here, as they go beside this text as image content blocks (`replyImages`).
 */
export function toolResultFor(reply: QuestionReply, rootPath: string): string {
  switch (reply.kind) {
    case QuestionReplyKind.Answers:
      return JSON.stringify(answersResult(reply))
    case QuestionReplyKind.FreeText:
      return JSON.stringify({
        freeText: withAttachedFiles(agentText(reply.text, reply.pastedBlocks ?? []), reply.files ?? [], rootPath),
      })
  }
}

/** The images a reply carries, with their bytes, as their ids name them in the images table; none when it has no images. */
export function replyImages(db: Database, reply: QuestionReply): ImageData[] {
  if (reply.kind !== QuestionReplyKind.FreeText || reply.images === undefined) return []
  return reply.images.flatMap(({ id }) => {
    const image = getImage(db, id)
    return image === undefined ? [] : [image]
  })
}

/**
 * What a question set's notification says: the first line of the preamble that has any text, or with none, the first
 * question. The notification makes it plain text and cuts it short.
 */
export function notificationText({ preamble, questions }: Asking): string {
  const line = preamble?.split('\n').find((candidate) => plainText(candidate) !== '')
  return line ?? questions[0]?.prompt ?? ''
}

/**
 * The broker for a task service. `notify` notifies questions asked in a task you aren't viewing, as the runner's
 * `notifyReply` does a reply; nothing by default.
 */
export function createQuestionBroker(
  context: TaskServiceContext,
  notify: NotifyReply = () => undefined,
): QuestionBroker {
  const { db, emit } = context
  /** The calls waiting on their sets, by set id. */
  const waiting = new Map<string, (outcome: QuestionReply | null | typeof ASK_PARKED) => void>()

  /** The task's `asking` changed, and nothing else: tells the windows, without stamping it as changed. */
  const askingChanged = (taskId: string): void => {
    const task = getTask(db, taskId)
    if (task !== undefined) emitTaskUpdated(emit, task)
  }

  /** Closes an open set, tells the windows, and lets the call waiting on it go. Undefined when it isn't open. */
  const close = (id: string, closing: QuestionSetClosing): QuestionSet | undefined => {
    const closed = closeQuestionSet(db, id, closing)
    if (closed === undefined) return undefined
    emitQuestionSet(emit, closed)
    const resolve = waiting.get(id)
    waiting.delete(id)
    resolve?.(closed.reply)
    return closed
  }

  const withdraw = (taskId: string): void => {
    const open = getOpenQuestionSet(db, taskId)
    if (open === undefined) return
    close(open.id, { state: QuestionSetState.Withdrawn })
    askingChanged(taskId)
  }

  return {
    ask(taskId, asking, signal) {
      const set = appendQuestionSet(db, { taskId, turn: Math.max(1, lastTurn(db, taskId)), ...asking })
      emitQuestionSet(emit, set)
      updateTaskFromRunner(context, taskId, { activity: TaskActivity.Waiting })
      if (noteAgentReply(context, taskId)) notify(taskId, notificationText(asking))
      return new Promise((resolve) => {
        waiting.set(set.id, resolve)
        const cancel = (): void => {
          if (!waiting.has(set.id)) return
          if (close(set.id, { state: QuestionSetState.Withdrawn }) !== undefined) askingChanged(taskId)
        }
        if (signal?.aborted === true) cancel()
        else signal?.addEventListener('abort', cancel, { once: true })
      })
    },

    isWaiting(id) {
      return waiting.has(id)
    },

    park(taskId) {
      const open = getOpenQuestionSet(db, taskId)
      if (open === undefined) return false
      const resolve = waiting.get(open.id)
      if (resolve === undefined) return false
      waiting.delete(open.id)
      resolve(ASK_PARKED)
      return true
    },

    answer(id, reply) {
      const set = getQuestionSet(db, id)
      if (set === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No question set ${id}`)
      const live = waiting.has(id)
      const answered = close(id, { state: QuestionSetState.Answered, reply })
      if (answered === undefined) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'The questions are not open any more')
      }
      // The call waiting on it carries the turn on; with none, the runner starts the agent again itself.
      if (live) updateTaskFromRunner(context, set.taskId, { activity: TaskActivity.Working })
      else askingChanged(set.taskId)
      return answered
    },

    withdraw,

    close() {
      waiting.clear()
    },
  }
}
