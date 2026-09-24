/**
 * The agent's questions (`ask`, `docs/model-surface.md`), from the call that asks them to the answer it waits on.
 *
 * - **Asking** saves an open question set for the task (so it outlives the app), tells the windows (`question.opened`)
 *   and waits, however long it takes, until the set is answered or withdrawn. The task's agent is waiting on you while
 *   it does, though its turn is still running: its activity is waiting, and `task.asking` is true.
 * - **Answering** closes the set with your reply (`question.answered`), and the call that waits on it returns it; the
 *   task is working again.
 * - **Withdrawing** closes the set without one (`question.withdrawn`), when the turn that asked it ends some other way:
 *   it was stopped, or it failed. The call that waits on it returns nothing.
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
import { CommandFailure } from '../bridge/errors'
import { emitQuestionSet, emitTaskUpdated } from '../bridge/events'
import { lastTurn } from '../db/repositories/messages'
import {
  appendQuestionSet,
  closeQuestionSet,
  getOpenQuestionSet,
  getQuestionSet,
  type QuestionSetClosing,
} from '../db/repositories/question-sets'
import { getTask } from '../db/repositories/tasks'
import { updateTaskFromRunner, type TaskServiceContext } from '../tasks/service'

export interface QuestionBroker {
  /**
   * Opens a question set for the task and waits on it. Resolves with your reply once it's answered, or null once it's
   * withdrawn, or `signal` aborts (the SDK cancelled the call), which withdraws it.
   */
  ask(taskId: string, questions: readonly Question[], signal?: AbortSignal): Promise<QuestionReply | null>
  /** Whether a call in this process is waiting on the set. */
  isWaiting(id: string): boolean
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

/** What the `ask` tool gives the model for a reply: the answers keyed by question index, or `{ freeText }`. */
export function toolResultFor(reply: QuestionReply): string {
  switch (reply.kind) {
    case QuestionReplyKind.Answers:
      return JSON.stringify(reply.answers)
    case QuestionReplyKind.FreeText:
      return JSON.stringify({ freeText: reply.text })
  }
}

export function createQuestionBroker(context: TaskServiceContext): QuestionBroker {
  const { db, emit } = context
  /** The calls waiting on their sets, by set id. */
  const waiting = new Map<string, (reply: QuestionReply | null) => void>()

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
    ask(taskId, questions, signal) {
      const set = appendQuestionSet(db, { taskId, turn: Math.max(1, lastTurn(db, taskId)), questions })
      emitQuestionSet(emit, set)
      updateTaskFromRunner(context, taskId, { activity: TaskActivity.Waiting })
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
