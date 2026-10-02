import { describe, expect, it } from 'vitest'
import { QuestionKind, QuestionReplyKind, type Question, type QuestionAnswers } from './domain'
import { ANYTHING_ELSE_KEY, answersResult, checkAnswers, tidyAnythingElse } from './questions'

const LAYOUT: Question = {
  kind: QuestionKind.Choice,
  prompt: 'How should the notes be laid out?',
  options: [
    { id: 'by-type', label: 'By type' },
    { id: 'by-area', label: 'By area' },
  ],
}
const SECTIONS: Question = { ...LAYOUT, prompt: 'Which sections?', multiple: true }
const CREDITS: Question = {
  kind: QuestionKind.Pills,
  prompt: 'Credit contributors?',
  options: ['GitHub handles', 'Full names', 'No credits'],
}
const PLATFORMS: Question = { ...CREDITS, prompt: 'Which platforms?', multiple: true }
const NAME: Question = { kind: QuestionKind.Text, prompt: 'What should the release be called?' }
const NOTES: Question = { kind: QuestionKind.Text, prompt: 'Anything else?', optional: true }

describe('checkAnswers', () => {
  it('takes an answer for every kind of question, keyed by index, with text trimmed', () => {
    const questions = [LAYOUT, SECTIONS, CREDITS, PLATFORMS, NAME, NOTES]
    const answers: QuestionAnswers = {
      0: 'by-type',
      1: ['by-area', 'by-type'],
      2: 'No credits',
      3: ['Full names'],
      4: '  Aurora \n',
      5: 'Mention the new rate limits.',
    }

    expect(checkAnswers(questions, answers)).toEqual({
      ok: true,
      answers: { ...answers, 4: 'Aurora' },
    })
  })

  it('drops an optional text question left empty, whether it was sent or not', () => {
    expect(checkAnswers([LAYOUT, NOTES], { 0: 'by-area', 1: '   ' })).toEqual({ ok: true, answers: { 0: 'by-area' } })
    expect(checkAnswers([LAYOUT, NOTES], { 0: 'by-area' })).toEqual({ ok: true, answers: { 0: 'by-area' } })
  })

  it('takes no answers at all: every question is optional', () => {
    const questions = [LAYOUT, SECTIONS, CREDITS, PLATFORMS, NAME, NOTES]

    expect(checkAnswers(questions, {})).toEqual({ ok: true, answers: {} })
  })

  it('takes some answers, leaving out the questions skipped, whatever their kind', () => {
    const questions = [LAYOUT, SECTIONS, CREDITS, PLATFORMS, NAME, NOTES]

    expect(checkAnswers(questions, { 2: 'Full names', 4: ' Aurora ' })).toEqual({
      ok: true,
      answers: { 2: 'Full names', 4: 'Aurora' },
    })
    expect(checkAnswers(questions, { 0: 'by-type', 5: 'Rate limits.' })).toEqual({
      ok: true,
      answers: { 0: 'by-type', 5: 'Rate limits.' },
    })
  })

  it('drops an empty list and blank text, as unanswered, for a question without `optional` too', () => {
    expect(checkAnswers([SECTIONS, PLATFORMS, NAME], { 0: [], 1: [], 2: ' \n ' })).toEqual({ ok: true, answers: {} })
  })

  it('ignores `optional: false`: the question can still be skipped', () => {
    const required: Question = { kind: QuestionKind.Text, prompt: 'Name?', optional: false }

    expect(checkAnswers([required], {})).toEqual({ ok: true, answers: {} })
  })

  it('refuses anythingElse among the answers: it is not a question', () => {
    expect(checkAnswers([LAYOUT], { [ANYTHING_ELSE_KEY]: 'By type, mostly.' })).toEqual({
      ok: false,
      problems: ['anythingElse: there is no such question'],
    })
  })

  it.each<[string, readonly Question[], QuestionAnswers, readonly string[]]>([
    ['an unknown option', [LAYOUT], { 0: 'by-date' }, ['0: has no option "by-date"']],
    ['a list for one pick', [LAYOUT], { 0: ['by-type'] }, ['0: takes one answer, not a list']],
    ['one pick where a list is taken', [SECTIONS], { 0: 'by-type' }, ['0: takes a list of answers']],
    ['an unknown pill in a list', [PLATFORMS], { 0: ['Full names', 'Nicknames'] }, ['0: has no option "Nicknames"']],
    ['a pill picked twice', [PLATFORMS], { 0: ['Full names', 'Full names'] }, ['0: has an option picked twice']],
    ['a pill that is not there', [CREDITS], { 0: 'Maybe' }, ['0: has no option "Maybe"']],
    ['a list for text', [NOTES], { 0: ['Aurora'] }, ['0: takes text, not a list']],
    [
      'an answer to no question',
      [LAYOUT],
      { 0: 'by-type', 1: 'x', first: 'y' },
      ['1: there is no such question', 'first: there is no such question'],
    ],
    ['an index spelt another way', [LAYOUT], { '00': 'by-type' }, ['00: there is no such question']],
  ])('refuses %s', (_, questions, answers, problems) => {
    expect(checkAnswers(questions, answers)).toEqual({ ok: false, problems })
  })

  it('reports every problem at once', () => {
    expect(checkAnswers([LAYOUT, CREDITS, NAME], { 0: 'by-date', 1: 'Maybe', 2: ['x'] })).toEqual({
      ok: false,
      problems: ['0: has no option "by-date"', '1: has no option "Maybe"', '2: takes text, not a list'],
    })
  })
})

describe('tidyAnythingElse', () => {
  it('trims the text', () => {
    expect(tidyAnythingElse('  Hold the email.\n')).toBe('Hold the email.')
    expect(tidyAnythingElse('Line one\n\nLine two')).toBe('Line one\n\nLine two')
  })

  it('leaves out nothing, blank or missing text', () => {
    expect(tidyAnythingElse('')).toBeUndefined()
    expect(tidyAnythingElse(' \n\t ')).toBeUndefined()
    expect(tidyAnythingElse(undefined)).toBeUndefined()
  })
})

describe('answersResult', () => {
  it('is the answers alone without anything else', () => {
    expect(answersResult({ kind: QuestionReplyKind.Answers, answers: { 0: 'by-type' } })).toEqual({ 0: 'by-type' })
    expect(answersResult({ kind: QuestionReplyKind.Answers, answers: {} })).toEqual({})
  })

  it('adds anythingElse beside the numbered answers', () => {
    expect(
      answersResult({ kind: QuestionReplyKind.Answers, answers: { 1: ['a', 'b'] }, anythingElse: 'Ship it Friday.' }),
    ).toEqual({ 1: ['a', 'b'], anythingElse: 'Ship it Friday.' })
    expect(answersResult({ kind: QuestionReplyKind.Answers, answers: {}, anythingElse: 'None fit.' })).toEqual({
      anythingElse: 'None fit.',
    })
  })
})
