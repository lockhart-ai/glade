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
  optionValues,
  pick,
  picked,
  sendLabel,
  sketchLines,
  SKIPPED,
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

  it('sends nothing at all: every question is optional', () => {
    expect(answersToSend(questions, {})).toEqual({})
    expect(answersToSend([LAYOUT, AREAS, CREDITS, TAGS, NOTE, REASON], {})).toEqual({})
  })

  it('sends only the questions answered, leaving out empty lists and blank text', () => {
    expect(answersToSend(questions, { 0: 'by-type', 1: [] })).toEqual({ 0: 'by-type' })
    expect(answersToSend(questions, { 1: ['b'], 2: '  ' })).toEqual({ 1: ['b'] })
    expect(answersToSend(questions, { 2: 'Only this.' })).toEqual({ 2: 'Only this.' })
  })

  it('is null for a draft main would refuse, which the card never makes', () => {
    expect(answersToSend(questions, { 0: 'by-date' })).toBeNull()
  })

  it('leaves out an optional text question left blank, and trims text', () => {
    expect(answersToSend(questions, { 0: 'by-type', 1: ['a'], 2: ' ' })).toEqual({ 0: 'by-type', 1: ['a'] })
    expect(answersToSend(questions, { 0: 'by-type', 1: ['a'], 2: ' Thanks ' })).toEqual({
      0: 'by-type',
      1: ['a'],
      2: 'Thanks',
    })
  })

  it('lets a text question without `optional` be skipped too', () => {
    expect(answersToSend([REASON], {})).toEqual({})
    expect(answersToSend([REASON], { 0: 'Because.' })).toEqual({ 0: 'Because.' })
  })
})

describe('sendLabel', () => {
  const questions = [LAYOUT, NOTE]

  it('offers to skip the questions while nothing is answered or typed', () => {
    expect(sendLabel(questions, {}, '')).toBe('Skip questions')
    expect(sendLabel(questions, { 0: [] as readonly string[], 1: '  ' }, ' \n ')).toBe('Skip questions')
  })

  it('sends answers once anything is answered, or typed in "Anything else?"', () => {
    expect(sendLabel(questions, { 0: 'by-type' }, '')).toBe('Send answers')
    expect(sendLabel(questions, { 1: 'Thanks' }, '')).toBe('Send answers')
    expect(sendLabel(questions, {}, 'None of these.')).toBe('Send answers')
  })
})

describe('titles', () => {
  it('counts the questions before I finish', () => {
    expect(cardTitle([LAYOUT, CREDITS, NOTE])).toBe('3 questions before I finish')
    expect(cardTitle([LAYOUT])).toBe('1 question before I finish')
  })

  it('says how a closed card was closed', () => {
    expect(closedTitle([LAYOUT, CREDITS], ClosedAs.Answers)).toBe('2 questions · answered')
    expect(closedTitle([LAYOUT, CREDITS], ClosedAs.Skipped)).toBe('2 questions · skipped')
    expect(closedTitle([LAYOUT], ClosedAs.InWords)).toBe('1 question · answered in your words')
    expect(closedTitle([LAYOUT, CREDITS], ClosedAs.Withdrawn)).toBe('2 questions · withdrawn')
  })
})

describe('closedAs', () => {
  it('is null while open, and says how it closed', () => {
    expect(closedAs({ state: QuestionSetState.Open, reply: null })).toBeNull()
    expect(closedAs({ state: QuestionSetState.Withdrawn, reply: null })).toBe(ClosedAs.Withdrawn)
    expect(
      closedAs({ state: QuestionSetState.Answered, reply: { kind: QuestionReplyKind.Answers, answers: { 0: 'x' } } }),
    ).toBe(ClosedAs.Answers)
    expect(closedAs({ state: QuestionSetState.Answered, reply: { kind: QuestionReplyKind.FreeText, text: 'x' } })).toBe(
      ClosedAs.InWords,
    )
  })

  it('is skipped for a card sent with nothing answered and nothing else typed, and answered with either', () => {
    const answered = (reply: { readonly answers: Record<string, string>; readonly anythingElse?: string }) =>
      closedAs({ state: QuestionSetState.Answered, reply: { kind: QuestionReplyKind.Answers, ...reply } })

    expect(answered({ answers: {} })).toBe(ClosedAs.Skipped)
    expect(answered({ answers: {}, anythingElse: 'Ask me later.' })).toBe(ClosedAs.Answers)
    expect(answered({ answers: { 1: 'Names' } })).toBe(ClosedAs.Answers)
  })
})

describe('answerText', () => {
  it("shows a choice's labels, the pills and the text, or that the question was skipped", () => {
    expect(answerText(LAYOUT, 'by-area')).toBe('By area')
    expect(answerText(AREAS, ['api', 'web'])).toBe('API, Web')
    expect(answerText(AREAS, ['gone'])).toBe('gone')
    expect(answerText(TAGS, ['a', 'c'])).toBe('a, c')
    expect(answerText(NOTE, 'Thanks')).toBe('Thanks')
    expect(answerText(NOTE, undefined)).toBe(SKIPPED)
    expect(answerText(LAYOUT, undefined)).toBe('Skipped')
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
