import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  type Question,
  type QuestionReply,
  type Task,
} from '../../../shared/domain'
import { AttachedFileKind } from '../../../shared/attachedFiles'
import { ImageMediaType } from '../../../shared/images'
import {
  appendQuestionSet,
  closeQuestionSet,
  getOpenQuestionDraft,
  getOpenQuestionSet,
  getQuestionSet,
  listOpenQuestionSets,
  listQuestionSets,
  setQuestionDraft,
} from './question-sets'
import { deleteTask, getTask } from './tasks'
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
      preamble: null,
      questions: QUESTIONS,
      state: QuestionSetState.Open,
      reply: null,
      createdAt: 5_000,
      closedAt: null,
    })
    expect(getQuestionSet(test.db, set.id)).toEqual(set)
    expect(getQuestionSet(test.db, 'gone')).toBeUndefined()
  })

  it('keeps the preamble a set was asked with, once it is answered or withdrawn', () => {
    const preamble = 'Yes, the tests pass on `main`.\n\n- one\n- two'
    const answered = appendQuestionSet(test.db, { taskId: task.id, turn: 1, preamble, questions: QUESTIONS })
    const withdrawn = appendQuestionSet(test.db, { taskId: task.id, turn: 2, preamble, questions: QUESTIONS })
    expect(answered.preamble).toBe(preamble)

    closeQuestionSet(test.db, answered.id, { state: QuestionSetState.Answered, reply: ANSWERS })
    closeQuestionSet(test.db, withdrawn.id, { state: QuestionSetState.Withdrawn })

    expect(listQuestionSets(test.db, task.id).map((set) => [set.state, set.preamble])).toEqual([
      [QuestionSetState.Answered, preamble],
      [QuestionSetState.Withdrawn, preamble],
    ])
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

  it('keeps an answer in words with its images, pasted text and files (#648)', () => {
    const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
    const words: QuestionReply = {
      kind: QuestionReplyKind.FreeText,
      text: 'Like this.',
      images: [{ id: 'img-1', mediaType: ImageMediaType.Png }],
      pastedBlocks: [{ id: 'k3f9', text: 'KeyError: user_id' }],
      files: [{ name: 'sales.csv', path: '.glade/attachments/t1/sales.csv', size: 23, kind: AttachedFileKind.Text }],
    }

    closeQuestionSet(test.db, set.id, { state: QuestionSetState.Answered, reply: words })

    expect(getQuestionSet(test.db, set.id)?.reply).toEqual(words)
  })

  it('keeps a skipped card\'s "Anything else?" text, and reads a reply stored without one', () => {
    const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
    const other: QuestionReply = { kind: QuestionReplyKind.Answers, answers: {}, anythingElse: 'None of these fit.' }

    closeQuestionSet(test.db, set.id, { state: QuestionSetState.Answered, reply: other })
    expect(getQuestionSet(test.db, set.id)?.reply).toEqual(other)

    // A reply stored before the box was there (#397) has no anythingElse, and still reads back.
    test.db
      .prepare('UPDATE question_sets SET reply = ? WHERE id = ?')
      .run('{"kind":"answers","answers":{"0":"x"}}', set.id)
    expect(getQuestionSet(test.db, set.id)?.reply).toEqual({ kind: QuestionReplyKind.Answers, answers: { 0: 'x' } })

    test.db
      .prepare('UPDATE question_sets SET reply = ? WHERE id = ?')
      .run('{"kind":"answers","answers":{},"anythingElse":7}', set.id)
    expect(() => getQuestionSet(test.db, set.id)).toThrow(/question_sets\.reply/)
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

  describe('the card draft', () => {
    it('keeps what a card has filled in on an open set, and gives it back with the set it is for', () => {
      const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
      expect(getOpenQuestionDraft(test.db, task.id)).toBeNull()

      expect(
        setQuestionDraft(test.db, task.id, {
          questionSetId: set.id,
          draft: { 0: 'by-type', 1: ['No credits'], 2: 'See the 429s' },
          anythingElse: 'And hurry.',
        }),
      ).toBe(true)

      expect(getOpenQuestionDraft(test.db, task.id)).toEqual({
        questionSetId: set.id,
        draft: { 0: 'by-type', 1: ['No credits'], 2: 'See the 429s' },
        anythingElse: 'And hurry.',
      })
    })

    it('stores none for a draft with nothing left in it, and drops the one there was', () => {
      const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })

      expect(
        setQuestionDraft(test.db, task.id, { questionSetId: set.id, draft: { 2: '  ' }, anythingElse: ' \n ' }),
      ).toBe(true)
      expect(getOpenQuestionDraft(test.db, task.id)).toBeNull()

      expect(
        setQuestionDraft(test.db, task.id, {
          questionSetId: set.id,
          draft: { 1: ['GitHub handles'] },
          anythingElse: '',
        }),
      ).toBe(true)
      expect(setQuestionDraft(test.db, task.id, { questionSetId: set.id, draft: {}, anythingElse: ' ' })).toBe(true)
      expect(getOpenQuestionDraft(test.db, task.id)).toBeNull()
      expect(setQuestionDraft(test.db, task.id, null)).toBe(true)
      expect(getOpenQuestionDraft(test.db, task.id)).toBeNull()
    })

    it('answers false, and stores nothing, for a set that is closed, another task’s, or not there', () => {
      const closed = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
      closeQuestionSet(test.db, closed.id, { state: QuestionSetState.Withdrawn })
      const other = sampleTask(test.db, task.workspaceId)
      const theirs = appendQuestionSet(test.db, { taskId: other.id, turn: 1, questions: QUESTIONS })
      const draft = { questionSetId: closed.id, draft: { 0: 'by-type' }, anythingElse: '' }

      expect(setQuestionDraft(test.db, task.id, draft)).toBe(false)
      expect(setQuestionDraft(test.db, task.id, { ...draft, questionSetId: theirs.id })).toBe(false)
      expect(setQuestionDraft(test.db, task.id, { ...draft, questionSetId: 'gone' })).toBe(false)
      expect(setQuestionDraft(test.db, 'missing', draft)).toBe(false)
      expect(test.db.prepare('SELECT COUNT(*) FROM question_sets WHERE draft IS NOT NULL').pluck().get()).toBe(0)
    })

    it('goes with the set, which takes none once it is answered or withdrawn', () => {
      const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
      setQuestionDraft(test.db, task.id, { questionSetId: set.id, draft: { 0: 'by-type' }, anythingElse: 'Hurry.' })

      closeQuestionSet(test.db, set.id, { state: QuestionSetState.Answered, reply: ANSWERS })

      expect(getOpenQuestionDraft(test.db, task.id)).toBeNull()
      expect(test.db.prepare('SELECT draft FROM question_sets WHERE id = ?').pluck().get(set.id)).toBeNull()
    })

    it('keeps each task’s draft apart, and deletes one with its task', () => {
      const other = sampleTask(test.db, task.workspaceId)
      const first = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
      const second = appendQuestionSet(test.db, { taskId: other.id, turn: 1, questions: QUESTIONS })
      setQuestionDraft(test.db, task.id, { questionSetId: first.id, draft: { 0: 'by-type' }, anythingElse: 'Mine.' })
      setQuestionDraft(test.db, other.id, { questionSetId: second.id, draft: { 1: ['No credits'] }, anythingElse: '' })

      deleteTask(test.db, other.id)

      expect(getOpenQuestionDraft(test.db, task.id)).toEqual({
        questionSetId: first.id,
        draft: { 0: 'by-type' },
        anythingElse: 'Mine.',
      })
      expect(getOpenQuestionDraft(test.db, other.id)).toBeNull()
    })

    it('refuses a stored draft that is not what the schema promises', () => {
      const set = appendQuestionSet(test.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
      setQuestionDraft(test.db, task.id, { questionSetId: set.id, draft: { 0: 'by-type' }, anythingElse: '' })
      test.db.prepare('UPDATE question_sets SET draft = ? WHERE id = ?').run('{"draft":"by-type"}', set.id)

      expect(() => getOpenQuestionDraft(test.db, task.id)).toThrow(/question_sets\.draft/)
    })
  })
})
