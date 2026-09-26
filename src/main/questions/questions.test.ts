import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  UiStateKey,
} from '../../shared/domain'
import { appendMessage } from '../db/repositories/messages'
import { appendQuestionSet, getQuestionSet } from '../db/repositories/question-sets'
import { getTask } from '../db/repositories/tasks'
import { setUiState } from '../db/repositories/ui-state'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createQuestionBroker, notificationText, toolResultFor, type QuestionBroker } from './questions'

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
  // You're viewing the task, so its questions notify nothing; see "notifications" below for one you aren't.
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
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

describe('notificationText', () => {
  it('says the first line of the preamble, or with none, the first question', () => {
    expect(notificationText({ questions: QUESTIONS })).toBe('Credit contributors?')
    expect(notificationText({ preamble: 'Yes, they pass.\n\nA few choices first.', questions: QUESTIONS })).toBe(
      'Yes, they pass.',
    )
  })

  it('skips lines with no text once the Markdown is gone, and falls back to the first question if none has any', () => {
    expect(notificationText({ preamble: '\n```ts\nconst limit = 100\n```', questions: QUESTIONS })).toBe(
      'const limit = 100',
    )
    expect(notificationText({ preamble: '---\n\n```\n```', questions: QUESTIONS })).toBe('Credit contributors?')
    expect(notificationText({ preamble: '---', questions: [] })).toBe('')
  })
})

describe('the question broker: notifications', () => {
  it("notifies the preamble's first line for a set asked with one, and saves the preamble with the set", () => {
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: 'another-task' })
    const notify = vi.fn()
    const notifying = createQuestionBroker({ db: database.db, emit: (event) => events.push(event) }, notify)
    const preamble = '## Short answer\nThe **tests pass** on `main`.'

    void notifying.ask(task.id, { preamble, questions: QUESTIONS })

    expect(notify).toHaveBeenCalledWith(task.id, '## Short answer')
    const [opened] = events.flatMap((event) => (event.type === EventType.QuestionOpened ? [event.questionSet] : []))
    expect(opened?.preamble).toBe(preamble)
    expect(opened === undefined ? undefined : getQuestionSet(database.db, opened.id)?.preamble).toBe(preamble)
  })

  it("marks a task you aren't viewing unread and notifies its first question, once per set", () => {
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: 'another-task' })
    const notify = vi.fn()
    const notifying = createQuestionBroker({ db: database.db, emit: (event) => events.push(event) }, notify)
    const questions: Question[] = [...QUESTIONS, { kind: QuestionKind.Text, prompt: 'Anything else?', optional: true }]

    void notifying.ask(task.id, { questions })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(task.id, 'Credit contributors?')
    expect(current().unread).toBe(true)
  })

  it('notifies nothing for the task you are viewing, and leaves it read', () => {
    const notify = vi.fn()
    const notifying = createQuestionBroker({ db: database.db, emit: (event) => events.push(event) }, notify)

    void notifying.ask(task.id, { questions: QUESTIONS })

    expect(notify).not.toHaveBeenCalled()
    expect(current().unread).toBe(false)
  })

  it('marks the task unread without a notifier to call', () => {
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: 'another-task' })

    void broker.ask(task.id, { questions: QUESTIONS })

    expect(current().unread).toBe(true)
  })
})

describe('the question broker', () => {
  it("opens a set in the task's latest turn, and the task waits on you until it is answered", async () => {
    appendMessage(database.db, { taskId: task.id, role: MessageRole.User, body: 'Draft the notes.', turn: 3 })

    const asked = broker.ask(task.id, { questions: QUESTIONS })
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
    void broker.ask(task.id, { questions: QUESTIONS })

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

    const asked = broker.ask(task.id, { questions: QUESTIONS })
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
    const asked = broker.ask(task.id, { questions: QUESTIONS }, cancel.signal)
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
    void broker.ask(task.id, { questions: QUESTIONS }, cancel.signal)
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
    const asked = broker.ask(task.id, { questions: QUESTIONS }, cancel.signal)
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
