import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import {
  MessageRole,
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  type Question,
  type QuestionReply,
  type Task,
} from '../../shared/domain'
import { appendMessage } from '../db/repositories/messages'
import { appendQuestionSet, getQuestionSet } from '../db/repositories/question-sets'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createQuestionBroker, toolResultFor, type QuestionBroker } from './questions'

const QUESTIONS: Question[] = [
  { kind: QuestionKind.Pills, prompt: 'Credit contributors?', options: ['GitHub handles', 'No credits'] },
]
const ANSWERS: QuestionReply = { kind: QuestionReplyKind.Answers, answers: { 0: 'No credits' } }

let database: TestDatabase
let task: Task
let events: GladeEvent[]
let broker: QuestionBroker

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  events = []
  broker = createQuestionBroker({ db: database.db, emit: (event) => events.push(event) })
})

afterEach(() => {
  database.close()
})

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** A failure's code, for comparing. */
function failure(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error instanceof Error && 'code' in error ? error.code : error
  }
  return undefined
}

/** The events since the last call, as each one's type and what matters for it. */
function drain(): unknown[] {
  return events.splice(0).map((event) => {
    if (event.type === EventType.TaskUpdated) return [event.type, event.task.activity, event.task.asking]
    if ('questionSet' in event) return [event.type, event.questionSet.state]
    return [event.type]
  })
}

describe('toolResultFor', () => {
  it('gives the answers keyed by question index, or the answer in words as free text', () => {
    expect(toolResultFor({ kind: QuestionReplyKind.Answers, answers: { 0: 'by-type', 2: ['a', 'b'] } })).toBe(
      '{"0":"by-type","2":["a","b"]}',
    )
    expect(toolResultFor({ kind: QuestionReplyKind.FreeText, text: 'By type, "please".' })).toBe(
      '{"freeText":"By type, \\"please\\"."}',
    )
  })
})

describe('the question broker', () => {
  it("opens a set in the task's latest turn, and the task waits on you until it is answered", async () => {
    appendMessage(database.db, { taskId: task.id, role: MessageRole.User, body: 'Draft the notes.', turn: 3 })

    const asked = broker.ask(task.id, QUESTIONS)
    const [opened] = events.flatMap((event) => (event.type === EventType.QuestionOpened ? [event.questionSet] : []))
    if (opened === undefined) throw new Error('No question set opened')

    expect(opened).toMatchObject({ turn: 3, questions: QUESTIONS, state: QuestionSetState.Open })
    expect(broker.isWaiting(opened.id)).toBe(true)
    expect(drain()).toEqual([
      [EventType.QuestionOpened, QuestionSetState.Open],
      [EventType.TaskUpdated, TaskActivity.Waiting, true],
    ])

    expect(broker.answer(opened.id, ANSWERS)).toMatchObject({ state: QuestionSetState.Answered, reply: ANSWERS })

    await expect(asked).resolves.toEqual(ANSWERS)
    expect(broker.isWaiting(opened.id)).toBe(false)
    expect(drain()).toEqual([
      [EventType.QuestionAnswered, QuestionSetState.Answered],
      [EventType.TaskUpdated, TaskActivity.Working, false],
    ])
  })

  it('opens a set in turn 1 for a task with no messages yet', () => {
    void broker.ask(task.id, QUESTIONS)

    expect(getQuestionSet(database.db, openId())?.turn).toBe(1)
  })

  it("answers a set nothing waits on (the app quit on it) without changing the task's activity", () => {
    const set = appendQuestionSet(database.db, { taskId: task.id, turn: 1, questions: QUESTIONS })

    expect(broker.isWaiting(set.id)).toBe(false)
    broker.answer(set.id, ANSWERS)

    expect(getQuestionSet(database.db, set.id)?.state).toBe(QuestionSetState.Answered)
    expect(drain()).toEqual([
      [EventType.QuestionAnswered, QuestionSetState.Answered],
      [EventType.TaskUpdated, TaskActivity.Waiting, false],
    ])
    expect(current().updatedAt).toBe(task.updatedAt)
  })

  it('refuses to answer a set that is not there or not open', () => {
    const set = appendQuestionSet(database.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
    broker.answer(set.id, ANSWERS)

    expect(failure(() => broker.answer('gone', ANSWERS))).toBe(BridgeErrorCode.NotFound)
    expect(failure(() => broker.answer(set.id, ANSWERS))).toBe(BridgeErrorCode.InvalidTransition)
  })

  it("withdraws the task's open set, and does nothing when it has none", async () => {
    broker.withdraw(task.id)
    expect(events).toEqual([])

    const asked = broker.ask(task.id, QUESTIONS)
    drain()
    broker.withdraw(task.id)

    await expect(asked).resolves.toBeNull()
    expect(drain()).toEqual([
      [EventType.QuestionWithdrawn, QuestionSetState.Withdrawn],
      [EventType.TaskUpdated, TaskActivity.Waiting, false],
    ])
  })

  it('withdraws a set whose call the SDK cancels, once', async () => {
    const cancel = new AbortController()
    const asked = broker.ask(task.id, QUESTIONS, cancel.signal)
    drain()

    cancel.abort()

    await expect(asked).resolves.toBeNull()
    expect(drain()).toEqual([
      [EventType.QuestionWithdrawn, QuestionSetState.Withdrawn],
      [EventType.TaskUpdated, TaskActivity.Waiting, false],
    ])
  })

  it('keeps a set open when its call is cancelled after the broker is closed, as the app quits', () => {
    const cancel = new AbortController()
    void broker.ask(task.id, QUESTIONS, cancel.signal)
    const id = openId()
    drain()

    broker.close()
    cancel.abort()

    expect(broker.isWaiting(id)).toBe(false)
    expect(getQuestionSet(database.db, id)?.state).toBe(QuestionSetState.Open)
    expect(events).toEqual([])
  })

  it('leaves a set already answered alone when its call is cancelled after', async () => {
    const cancel = new AbortController()
    const asked = broker.ask(task.id, QUESTIONS, cancel.signal)
    const set = getQuestionSet(database.db, openId())
    if (set === undefined) throw new Error('No question set opened')
    broker.answer(set.id, ANSWERS)
    drain()

    cancel.abort()

    await expect(asked).resolves.toEqual(ANSWERS)
    expect(events).toEqual([])
    expect(getQuestionSet(database.db, set.id)?.state).toBe(QuestionSetState.Answered)
  })
})

/** The id of the set the broker last opened. */
function openId(): string {
  const opened = events.findLast((event) => event.type === EventType.QuestionOpened)
  if (opened?.type !== EventType.QuestionOpened) throw new Error('No question set opened')
  return opened.questionSet.id
}
