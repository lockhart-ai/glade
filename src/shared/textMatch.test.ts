import { describe, expect, it } from 'vitest'
import { foldText, matchesWords } from './textMatch'

describe('foldText', () => {
  it('lowercases and folds diacritics', () => {
    expect(foldText('Éclair Café')).toBe('eclair cafe')
    expect(foldText('GLM 5.3')).toBe('glm 5.3')
  })

  it('leaves plain text alone', () => {
    expect(foldText('DeepSeek V4 Flash')).toBe('deepseek v4 flash')
  })
})

describe('matchesWords', () => {
  const model = ['zai/glm-5.3-flash', 'Z.ai: GLM 5.3 Flash', 'A fast model for routine work']

  it('matches when every word appears across the fields, in any of them', () => {
    expect(matchesWords('glm flash', ...model)).toBe(true)
    expect(matchesWords('FAST routine', ...model)).toBe(true)
    expect(matchesWords('z.ai 5.3', ...model)).toBe(true)
  })

  it('needs every word: one missing word is no match', () => {
    expect(matchesWords('glm kimi', ...model)).toBe(false)
  })

  it('is not a substring match over the joined fields: the words must each appear', () => {
    expect(matchesWords('zaiglm', ...model)).toBe(false)
  })

  it('folds case and diacritics on both sides', () => {
    expect(matchesWords('GLM for routîne', ...model)).toBe(true)
    expect(matchesWords('Café', 'a cafe model')).toBe(true)
  })

  it('takes runs of whitespace as one break, and a blank query matches everything', () => {
    expect(matchesWords('  glm   flash  ', ...model)).toBe(true)
    expect(matchesWords('   ', ...model)).toBe(true)
    expect(matchesWords('', ...model)).toBe(true)
  })

  it('matches against the one text given', () => {
    expect(matchesWords('together', 'Together')).toBe(true)
    expect(matchesWords('novita', 'Together')).toBe(false)
  })
})
