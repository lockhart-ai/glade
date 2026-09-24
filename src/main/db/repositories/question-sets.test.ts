import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  type Question,
  type QuestionReply,
  type Task,
} from '../../../shared/domain'
import {
  appendQuestionSet,
  closeQuestionSet,
  getOpenQuestionSet,
  getQuestionSet,
  listOpenQuestionSets,
  listQuestionSets,
} from './question-sets'
import { getTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

const QUESTIONS: Question[] = [
  {
    kind: QuestionKind.Choice,
    prompt: 'How should the notes be laid out?',
    options: [
      { id: 'by-type', label: 'By type', detail: 'Features, fixes, internal.', sketch: '## Features' },
      { id: 'by-area', label: 'By area' },
    ],
    multiple: false,
  },
  { kind: QuestionKind.Pills, prompt: 'Credit contributors?', options: ['GitHub handles', 'No credits'] },
  { kind: QuestionKind.Text, prompt: 'Anything else?', placeholder: 'A known issue', optional: true },
]
const ANSWERS: QuestionReply = { kind: QuestionReplyKind.Answers, answers: { 0: 'by-type', 1: ['No credits'] } }

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

describe('question sets', () => {
  it('opens a set with its questions, and reads it back', () => {
    const set = appendQuestionSet(test.db, { taskId: task.id, turn: 2, questions: QUESTIONS }, 5_000)

    expect(set).toEqual({
      id: set.id,
      taskId: task.id,
      turn: 2,
      questions: QUESTIONS,
      state: QuestionSetState.Open,
      reply: null,
      createdAt: 5_000,
      closedAt: null,
    })
    expect(getQuestionSet(test.db, set.id)).toEqual(set)
    expect(getQuestionSet(test.db, 'gone')).toBeUndefined()
  })

  it("makes the task's asking true while a set is open", () => {
    expect(getTask(test.db, task.id)?.asking).toBe(false)
    const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
    expect(getTask(test.db, task.id)?.asking).toBe(true)

    closeQuestionSet(test.db, set.id, { state: QuestionSetState.Withdrawn })
    expect(getTask(test.db, task.id)?.asking).toBe(false)
  })

  it('answers a set with a reply, or withdraws it, once', () => {
    const answered = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS }, 5_000)
    const withdrawn = appendQuestionSet(test.db, { taskId: task.id, turn: 2, questions: QUESTIONS }, 6_000)
    const words: QuestionReply = { kind: QuestionReplyKind.FreeText, text: 'By type, please.' }

    expect(closeQuestionSet(test.db, answered.id, { state: QuestionSetState.Answered, reply: ANSWERS }, 7_000)).toEqual(
      { ...answered, state: QuestionSetState.Answered, reply: ANSWERS, closedAt: 7_000 },
    )
    expect(closeQuestionSet(test.db, withdrawn.id, { state: QuestionSetState.Withdrawn }, 8_000)).toEqual({
      ...withdrawn,
      state: QuestionSetState.Withdrawn,
      closedAt: 8_000,
    })
    expect(closeQuestionSet(test.db, answered.id, { state: QuestionSetState.Answered, reply: words })).toBeUndefined()
    expect(closeQuestionSet(test.db, 'gone', { state: QuestionSetState.Withdrawn })).toBeUndefined()
    expect(getQuestionSet(test.db, answered.id)?.reply).toEqual(ANSWERS)
  })

  it('keeps an answer in words', () => {
    const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
    const words: QuestionReply = { kind: QuestionReplyKind.FreeText, text: 'By type, please.' }

    closeQuestionSet(test.db, set.id, { state: QuestionSetState.Answered, reply: words })

    expect(getQuestionSet(test.db, set.id)?.reply).toEqual(words)
  })

  it("lists a task's sets in the order they were asked, and finds the open ones", () => {
    const other = sampleTask(test.db, task.workspaceId)
    const first = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS }, 5_000)
    const theirs = appendQuestionSet(test.db, { taskId: other.id, turn: 1, questions: QUESTIONS }, 5_500)
    const second = appendQuestionSet(test.db, { taskId: task.id, turn: 2, questions: QUESTIONS }, 6_000)
    closeQuestionSet(test.db, first.id, { state: QuestionSetState.Answered, reply: ANSWERS }, 6_500)

    expect(listQuestionSets(test.db, task.id).map(({ id }) => id)).toEqual([first.id, second.id])
    expect(getOpenQuestionSet(test.db, task.id)?.id).toBe(second.id)
    expect(listOpenQuestionSets(test.db).map(({ id }) => id)).toEqual([theirs.id, second.id])

    closeQuestionSet(test.db, second.id, { state: QuestionSetState.Withdrawn })
    expect(getOpenQuestionSet(test.db, task.id)).toBeUndefined()
  })

  it('refuses a row whose questions or reply are not what the schema promises', () => {
    const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })

    test.db.prepare("UPDATE question_sets SET questions = '[]' WHERE id = ?").run(set.id)
    expect(() => getQuestionSet(test.db, set.id)).toThrow(/question_sets\.questions/)

    test.db
      .prepare('UPDATE question_sets SET questions = ?, reply = ? WHERE id = ?')
      .run(JSON.stringify(QUESTIONS), '{"kind":"shrug"}', set.id)
    expect(() => getQuestionSet(test.db, set.id)).toThrow(/question_sets\.reply/)
  })
})
