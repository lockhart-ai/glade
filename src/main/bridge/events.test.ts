import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { MessageRole, QuestionKind, QuestionReplyKind, QuestionSetState } from '../../shared/domain'
import { appendQuestionSet } from '../db/repositories/question-sets'
import { appendMessage } from '../db/repositories/messages'
import { appendNarration } from '../db/repositories/tool-events'
import { appendQueuedMessage } from '../db/repositories/queued-messages'
import {
  emitMessageAppended,
  emitQuestionSet,
  emitQueueChanged,
  emitTaskUpdated,
  emitToolEventAppended,
  emitToolEventUpdated,
} from './events'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

it('emitTaskUpdated sends the whole task as a task.updated event', () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const emit = vi.fn()

  emitTaskUpdated(emit, task)

  expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.TaskUpdated, task })
})

it("emits a task's appended message and its appended and updated tool events", () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const message = appendMessage(database.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 })
  const toolEvent = appendNarration(database.db, { taskId: task.id, turn: 1, text: 'Checking.' })
  const emit = vi.fn()

  emitMessageAppended(emit, message)
  emitToolEventAppended(emit, toolEvent)
  emitToolEventUpdated(emit, toolEvent)

  expect(emit.mock.calls).toEqual([
    [{ type: EventType.MessageAppended, message }],
    [{ type: EventType.ToolEventAppended, toolEvent }],
    [{ type: EventType.ToolEventUpdated, toolEvent }],
  ])
})

it("emits a task's whole queue as a queue.changed event", () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const queued = appendQueuedMessage(database.db, { taskId: task.id, body: 'Keep the filenames.' })
  const emit = vi.fn()

  emitQueueChanged(emit, task.id, [queued])

  expect(emit).toHaveBeenCalledExactlyOnceWith({
    type: EventType.QueueChanged,
    taskId: task.id,
    queuedMessages: [queued],
  })
})

it('emits a question set as opened, answered or withdrawn, by its state', () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const questions = [{ kind: QuestionKind.Text, prompt: 'Anything else?' }] as const
  const open = appendQuestionSet(database.db, { taskId: task.id, turn: 1, questions })
  const answered = {
    ...open,
    state: QuestionSetState.Answered,
    reply: { kind: QuestionReplyKind.FreeText, text: 'No.' },
  } as const
  const withdrawn = { ...open, state: QuestionSetState.Withdrawn } as const
  const emit = vi.fn()

  for (const questionSet of [open, answered, withdrawn]) emitQuestionSet(emit, questionSet)

  expect(emit.mock.calls).toEqual([
    [{ type: EventType.QuestionOpened, questionSet: open }],
    [{ type: EventType.QuestionAnswered, questionSet: answered }],
    [{ type: EventType.QuestionWithdrawn, questionSet: withdrawn }],
  ])
})
