import { describe, expect, it } from 'vitest'
import { AutoCompactKind } from '../../shared/domain'
import { autoCompactFrom, carriedOver, sameAutoCompact } from './compaction'

describe('autoCompactFrom', () => {
  it('reads the threshold while auto-compact is on, as the probe saw it', () => {
    const usage = { totalTokens: 21_810, maxTokens: 100_000, percentage: 22, autocompactSource: 'settings' }
    expect(autoCompactFrom({ ...usage, autoCompactThreshold: 67_000, isAutoCompactEnabled: true })).toEqual({
      kind: AutoCompactKind.On,
      thresholdTokens: 67_000,
    })
  })

  it('reads auto-compact switched off, with no threshold', () => {
    expect(autoCompactFrom({ totalTokens: 1, isAutoCompactEnabled: false })).toEqual({ kind: AutoCompactKind.Off })
    // A threshold alongside it changes nothing: it doesn't compact.
    expect(autoCompactFrom({ isAutoCompactEnabled: false, autoCompactThreshold: 167_000 })).toEqual({
      kind: AutoCompactKind.Off,
    })
  })

  it('says nothing for an answer that does not say, so the last known value stays', () => {
    expect(autoCompactFrom({ isAutoCompactEnabled: true })).toBeUndefined()
    expect(autoCompactFrom({ isAutoCompactEnabled: true, autoCompactThreshold: -1 })).toBeUndefined()
    expect(autoCompactFrom({ isAutoCompactEnabled: true, autoCompactThreshold: '167000' })).toBeUndefined()
    expect(autoCompactFrom({ autoCompactThreshold: 167_000 })).toBeUndefined()
    expect(autoCompactFrom(null)).toBeUndefined()
    expect(autoCompactFrom('usage')).toBeUndefined()
  })
})

describe('sameAutoCompact', () => {
  const at = (thresholdTokens: number) => ({ kind: AutoCompactKind.On, thresholdTokens }) as const
  const off = { kind: AutoCompactKind.Off } as const

  it('matches the same answer, and nothing else', () => {
    expect(sameAutoCompact(at(167_000), at(167_000))).toBe(true)
    expect(sameAutoCompact(off, off)).toBe(true)
    expect(sameAutoCompact(at(167_000), at(67_000))).toBe(false)
    expect(sameAutoCompact(at(167_000), off)).toBe(false)
    expect(sameAutoCompact(off, at(167_000))).toBe(false)
    expect(sameAutoCompact(null, off)).toBe(false)
  })
})

describe('carriedOver', () => {
  it('is the summary block, without the analysis the model wrote first', () => {
    const written = [
      '<analysis>',
      'The user asked for three sentences about the moon.',
      '</analysis>',
      '',
      '<summary>',
      '1. Primary Request and Intent:',
      '   Three short sentences about the moon.',
      '</summary>',
    ].join('\n')
    expect(carriedOver(written)).toBe('1. Primary Request and Intent:\n   Three short sentences about the moon.')
  })

  it('is the text less any analysis without a summary block, trimmed', () => {
    expect(carriedOver('<analysis>Thinking.</analysis>\n\nMoved the uploads.\n')).toBe('Moved the uploads.')
    expect(carriedOver('  Moved the uploads.  ')).toBe('Moved the uploads.')
  })

  it('is empty for an empty summary, or one that is all analysis', () => {
    expect(carriedOver('')).toBe('')
    expect(carriedOver('<analysis>Only thinking.</analysis>')).toBe('')
    expect(carriedOver('<summary>\n\n</summary>')).toBe('')
  })
})
