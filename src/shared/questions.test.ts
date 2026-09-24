import { describe, expect, it } from 'vitest'
import { QuestionKind, type Question, type QuestionAnswers } from './domain'
import { checkAnswers } from './questions'

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

  it.each<[string, readonly Question[], QuestionAnswers, readonly string[]]>([
    ['an unanswered choice', [LAYOUT], {}, ['0: is not answered']],
    ['an unknown option', [LAYOUT], { 0: 'by-date' }, ['0: has no option "by-date"']],
    ['a list for one pick', [LAYOUT], { 0: ['by-type'] }, ['0: takes one answer, not a list']],
    ['one pick where a list is taken', [SECTIONS], { 0: 'by-type' }, ['0: takes a list of answers']],
    ['an empty list', [PLATFORMS], { 0: [] }, ['0: is not answered']],
    ['an unknown pill in a list', [PLATFORMS], { 0: ['Full names', 'Nicknames'] }, ['0: has no option "Nicknames"']],
    ['a pill picked twice', [PLATFORMS], { 0: ['Full names', 'Full names'] }, ['0: has an option picked twice']],
    ['a pill that is not there', [CREDITS], { 0: 'Maybe' }, ['0: has no option "Maybe"']],
    ['missing required text', [NAME], {}, ['0: is not answered']],
    ['blank required text', [NAME], { 0: '  ' }, ['0: is not answered']],
    ['a list for text', [NOTES], { 0: ['Aurora'] }, ['0: takes text, not a list']],
    [
      'an answer to no question',
      [LAYOUT],
      { 0: 'by-type', 1: 'x', first: 'y' },
      ['1: there is no such question', 'first: there is no such question'],
    ],
    [
      'an index spelt another way',
      [LAYOUT],
      { '00': 'by-type' },
      ['00: there is no such question', '0: is not answered'],
    ],
  ])('refuses %s', (_, questions, answers, problems) => {
    expect(checkAnswers(questions, answers)).toEqual({ ok: false, problems })
  })

  it('reports every problem at once', () => {
    expect(checkAnswers([LAYOUT, CREDITS, NAME], { 1: 'Maybe' })).toEqual({
      ok: false,
      problems: ['0: is not answered', '1: has no option "Maybe"', '2: is not answered'],
    })
  })
})
