import { describe, expect, it } from 'vitest'
import { QuestionKind, QuestionReplyKind, QuestionSetState, type Question } from '../../shared/domain'
import {
  answeredCount,
  answeredLabel,
  answersToSend,
  answerText,
  cardTitle,
  ClosedAs,
  closedAs,
  closedTitle,
  isAnswered,
  NO_ANSWER,
  optionValues,
  pick,
  picked,
  sketchLines,
  takesMany,
  typed,
} from './questionCardModel'

const LAYOUT: Question = {
  kind: QuestionKind.Choice,
  prompt: 'How should the notes be laid out?',
  options: [
    { id: 'by-type', label: 'By type' },
    { id: 'by-area', label: 'By area' },
  ],
}
const AREAS: Question = {
  kind: QuestionKind.Choice,
  prompt: 'Which areas?',
  options: [
    { id: 'api', label: 'API' },
    { id: 'admin', label: 'Admin' },
    { id: 'web', label: 'Web' },
  ],
  multiple: true,
}
const CREDITS: Question = { kind: QuestionKind.Pills, prompt: 'Credit contributors?', options: ['Handles', 'Names'] }
const TAGS: Question = { kind: QuestionKind.Pills, prompt: 'Tags?', options: ['a', 'b', 'c'], multiple: true }
const NOTE: Question = { kind: QuestionKind.Text, prompt: 'Anything else?', optional: true }
const REASON: Question = { kind: QuestionKind.Text, prompt: 'Why?' }

describe('options', () => {
  it("gives a choice's option ids, the pills' texts, and nothing for text", () => {
    expect(optionValues(LAYOUT)).toEqual(['by-type', 'by-area'])
    expect(optionValues(CREDITS)).toEqual(['Handles', 'Names'])
    expect(optionValues(NOTE)).toEqual([])
  })

  it('takes many only for a choice or pills with multiple', () => {
    expect([LAYOUT, AREAS, CREDITS, TAGS, NOTE].map(takesMany)).toEqual([false, true, false, true, false])
  })
})

describe('picking', () => {
  it('replaces the answer of a question that takes one', () => {
    const draft = pick(pick({}, LAYOUT, 0, 'by-type'), LAYOUT, 0, 'by-area')
    expect(draft).toEqual({ 0: 'by-area' })
    expect(picked(draft, 0)).toEqual(['by-area'])
    expect(picked(draft, 1)).toEqual([])
  })

  it("toggles an option of a question that takes many, keeping the options' order", () => {
    let draft = pick({}, AREAS, 1, 'web')
    draft = pick(draft, AREAS, 1, 'api')
    expect(draft).toEqual({ 1: ['api', 'web'] })
    draft = pick(draft, AREAS, 1, 'web')
    expect(picked(draft, 1)).toEqual(['api'])
    expect(pick(draft, AREAS, 1, 'api')).toEqual({ 1: [] })
  })
})

describe('answered', () => {
  it('counts a pick, or text that is not blank', () => {
    const draft = { ...pick({}, LAYOUT, 0, 'by-type'), 1: [], ...typed({}, 2, '  ') }
    expect(isAnswered(draft, 0)).toBe(true)
    expect(isAnswered(draft, 1)).toBe(false)
    expect(isAnswered(draft, 2)).toBe(false)
    expect(isAnswered(typed(draft, 2, 'yes'), 2)).toBe(true)
    expect(isAnswered(draft, 3)).toBe(false)
  })

  it('says how many of the questions are answered', () => {
    const questions = [LAYOUT, CREDITS, NOTE]
    const draft = pick({}, CREDITS, 1, 'Names')
    expect(answeredCount(questions, draft)).toBe(1)
    expect(answeredLabel(questions, draft)).toBe('1 of 3 answered')
  })
})

describe('answersToSend', () => {
  const questions = [LAYOUT, TAGS, NOTE]

  it('is null until every question but an optional text one is answered', () => {
    expect(answersToSend(questions, {})).toBeNull()
    expect(answersToSend(questions, { 0: 'by-type', 1: [] })).toBeNull()
  })

  it('leaves out an optional text question left blank, and trims text', () => {
    expect(answersToSend(questions, { 0: 'by-type', 1: ['a'], 2: ' ' })).toEqual({ 0: 'by-type', 1: ['a'] })
    expect(answersToSend(questions, { 0: 'by-type', 1: ['a'], 2: ' Thanks ' })).toEqual({
      0: 'by-type',
      1: ['a'],
      2: 'Thanks',
    })
  })

  it('needs text for a text question that is not optional', () => {
    expect(answersToSend([REASON], {})).toBeNull()
    expect(answersToSend([REASON], { 0: 'Because.' })).toEqual({ 0: 'Because.' })
  })
})

describe('titles', () => {
  it('counts the questions before I finish', () => {
    expect(cardTitle([LAYOUT, CREDITS, NOTE])).toBe('3 questions before I finish')
    expect(cardTitle([LAYOUT])).toBe('1 question before I finish')
  })

  it('says how a closed card was closed', () => {
    expect(closedTitle([LAYOUT, CREDITS], ClosedAs.Answers)).toBe('2 questions · answered')
    expect(closedTitle([LAYOUT], ClosedAs.InWords)).toBe('1 question · answered in your words')
    expect(closedTitle([LAYOUT, CREDITS], ClosedAs.Withdrawn)).toBe('2 questions · withdrawn')
  })
})

describe('closedAs', () => {
  it('is null while open, and says how it closed', () => {
    expect(closedAs({ state: QuestionSetState.Open, reply: null })).toBeNull()
    expect(closedAs({ state: QuestionSetState.Withdrawn, reply: null })).toBe(ClosedAs.Withdrawn)
    expect(
      closedAs({ state: QuestionSetState.Answered, reply: { kind: QuestionReplyKind.Answers, answers: {} } }),
    ).toBe(ClosedAs.Answers)
    expect(closedAs({ state: QuestionSetState.Answered, reply: { kind: QuestionReplyKind.FreeText, text: 'x' } })).toBe(
      ClosedAs.InWords,
    )
  })
})

describe('answerText', () => {
  it("shows a choice's labels, the pills and the text, or that there is no answer", () => {
    expect(answerText(LAYOUT, 'by-area')).toBe('By area')
    expect(answerText(AREAS, ['api', 'web'])).toBe('API, Web')
    expect(answerText(AREAS, ['gone'])).toBe('gone')
    expect(answerText(TAGS, ['a', 'c'])).toBe('a, c')
    expect(answerText(NOTE, 'Thanks')).toBe('Thanks')
    expect(answerText(NOTE, undefined)).toBe(NO_ANSWER)
  })
})

describe('sketchLines', () => {
  it('keeps each line as is, and makes lines starting with # headings without their marks', () => {
    expect(sketchLines('# Features\n  - one\n\n## Fixes')).toEqual([
      { text: 'Features', heading: true },
      { text: '  - one', heading: false },
      { text: '', heading: false },
      { text: 'Fixes', heading: true },
    ])
  })
})
