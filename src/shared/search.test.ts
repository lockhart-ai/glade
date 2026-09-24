import { describe, expect, it } from 'vitest'
import { ftsQuery, highlightParts, highlightPattern, mergeMatches, searchWords, type TextPart } from './search'

/** Parts as text, with the matches in [brackets]. */
function shown(parts: readonly TextPart[]): string {
  return parts.map(({ text, match }) => (match ? `[${text}]` : text)).join('')
}

function highlight(text: string, search: string): string {
  return shown(highlightParts(text, highlightPattern(search)))
}

describe('searchWords', () => {
  it('splits at whitespace, and each word into lowercased tokens of letters, digits and marks', () => {
    expect(searchWords('  Retry-After  429\tcafé ')).toEqual([['retry', 'after'], ['429'], ['café']])
  })

  it('drops words with no token', () => {
    expect(searchWords('"rate" -- * AND')).toEqual([['rate'], ['and']])
    expect(searchWords(' ')).toEqual([])
  })
})

describe('ftsQuery', () => {
  it('quotes each word as a prefix phrase, so nothing typed is query syntax', () => {
    expect(ftsQuery('Retry-After hea')).toBe('"retry after"* "hea"*')
    expect(ftsQuery('NEAR("rate" OR limit*)')).toBe('"near rate"* "or"* "limit"*')
  })

  it('is null for a search with no words', () => {
    expect(ftsQuery('')).toBeNull()
    expect(ftsQuery('"*"')).toBeNull()
  })
})

describe('highlighting', () => {
  it('marks what the search matches, whole words from their start, in any case', () => {
    // Matches with only a space between read as one.
    expect(highlight('Add rate limiting to the Rate API', 'rate lim')).toBe('Add [rate limiting] to the [Rate] API')
    expect(highlight('A pirate generates', 'rate')).toBe('A pirate generates')
  })

  it('marks a hyphenated word as one match, whatever joins its tokens', () => {
    expect(highlight('Send a Retry-After header, or a retry after one.', 'retry-after')).toBe(
      'Send a [Retry-After] header, or a [retry after] one.',
    )
  })

  it('prefers the longer word where two match at the same place', () => {
    expect(highlight('webhook retries', 'web webhook-retries')).toBe('[webhook retries]')
  })

  it('treats what could be pattern syntax as text', () => {
    expect(highlight('Costs $5 (plus tax), not 5+ tax', '$5 (plus')).toBe('Costs $[5 (plus] tax), not [5]+ tax')
  })

  it('marks nothing without a search', () => {
    expect(highlightPattern(' -- ')).toBeNull()
    expect(highlightParts('Add rate limiting', null)).toEqual([{ text: 'Add rate limiting', match: false }])
  })
})

describe('mergeMatches', () => {
  it('joins matches with only punctuation or spaces between, and drops empty parts', () => {
    expect(
      mergeMatches([
        { text: '', match: false },
        { text: 'Retry', match: true },
        { text: '-', match: false },
        { text: 'After', match: true },
        { text: '', match: true },
        { text: ' header ', match: false },
        { text: 'x', match: true },
      ]),
    ).toEqual([
      { text: 'Retry-After', match: true },
      { text: ' header ', match: false },
      { text: 'x', match: true },
    ])
  })

  it('joins adjacent matches, and keeps matches with words between them apart', () => {
    expect(
      mergeMatches([
        { text: 'rate', match: true },
        { text: 'limit', match: true },
        { text: ' and ', match: false },
        { text: 'key', match: true },
      ]),
    ).toEqual([
      { text: 'ratelimit', match: true },
      { text: ' and ', match: false },
      { text: 'key', match: true },
    ])
  })
})
