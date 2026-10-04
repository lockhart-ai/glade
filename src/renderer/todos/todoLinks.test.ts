import { describe, expect, it } from 'vitest'
import { SegmentKind, type Segment } from '../links'
import { hubFile, hubLink } from './test-hub'
import {
  linkAddresses,
  linkReferences,
  namedBy,
  NO_REFERENCES,
  sameReferences,
  todoSegments,
  type LinkReferences,
} from './todoLinks'

const PR_511 = 'https://github.com/acme/api/pull/511'
const ISSUE_501 = 'https://github.com/acme/api/issues/501'
const TICKET = 'https://acme.atlassian.net/browse/API-123'
const HANDBOOK = 'https://handbook.example.com/token-buckets'

/** What a task with these links may name. */
function references(...urls: string[]): LinkReferences {
  return linkReferences(urls.join('\n'))
}

/** The PR, the issue and the ticket above. */
const TASK = references(ISSUE_501, PR_511, TICKET, HANDBOOK)

/** A text's segments, each as `[its words]` for a link and as its words alone for text. */
function read(text: string, named = TASK): string[] {
  return todoSegments(text, named).map((segment) =>
    segment.kind === SegmentKind.Link ? `[${segment.text}]` : segment.text,
  )
}

/** The links among a text's segments, each as its words and the address it opens. */
function links(text: string, named = TASK): [string, string][] {
  return todoSegments(text, named).flatMap((segment): [string, string][] =>
    segment.kind === SegmentKind.Link ? [[segment.text, segment.href]] : [],
  )
}

describe('linkAddresses', () => {
  it('is the task’s link artifacts’ addresses, in order, a line each, and nothing of its files', () => {
    const artifacts = [hubLink(ISSUE_501, 'An issue'), hubFile('docs/a.md', 'A'), hubLink(PR_511, 'A PR')]
    expect(linkAddresses(artifacts)).toBe(`${ISSUE_501}\n${PR_511}`)
    expect(linkAddresses([hubFile('docs/a.md', 'A')])).toBe('')
    expect(linkAddresses([])).toBe('')
  })

  it('is the same value while the links are the same, whatever else of the artifacts changes', () => {
    const before = [hubLink(PR_511, 'A PR', 9), hubFile('docs/a.md', 'A', 5)]
    const after = [hubLink(PR_511, 'Renamed', 1), hubFile('docs/a.md', 'A', 0), hubFile('docs/b.md', 'B', 0)]
    expect(linkAddresses(after)).toBe(linkAddresses(before))
  })
})

describe('linkReferences', () => {
  it('names a PR and an issue by `#` and their number, and a ticket by its key, each with its address', () => {
    expect([...TASK]).toEqual([
      ['#501', ISSUE_501],
      ['#511', PR_511],
      ['API-123', TICKET],
    ])
  })

  it('names nothing for a task with no links, or only pages that are no PR, issue or ticket', () => {
    expect(linkReferences('')).toBe(NO_REFERENCES)
    expect(references(HANDBOOK, 'https://github.com/acme/api', 'https://github.com/acme/api/commit/42')).toBe(
      NO_REFERENCES,
    )
  })

  it('leaves out a number two of the links share: the same number in two repositories names neither', () => {
    const shared = references(PR_511, 'https://github.com/acme/web/pull/511', ISSUE_501)
    expect([...shared]).toEqual([['#501', ISSUE_501]])
    // A third with it changes nothing, and with nothing else left the task names nothing.
    expect(references(PR_511, 'https://github.com/acme/web/pull/511', 'https://github.com/acme/docs/issues/511')).toBe(
      NO_REFERENCES,
    )
  })

  it('leaves out a number an issue and a PR share, and one PR given by two of its pages', () => {
    expect(references(PR_511, 'https://github.com/acme/web/issues/511')).toBe(NO_REFERENCES)
    expect(references(PR_511, `${PR_511}/files`)).toBe(NO_REFERENCES)
  })

  it('leaves out a key two Jiras share', () => {
    expect(references(TICKET, 'https://jira.example.com/browse/API-123')).toBe(NO_REFERENCES)
  })

  it('names a ticket by its key in capitals, however its address writes it', () => {
    const lower = 'https://acme.atlassian.net/browse/api-123'
    expect([...references(lower)]).toEqual([['API-123', lower]])
  })

  it('keeps a number and a key apart: `#123` and `API-123` are two things', () => {
    const pr = 'https://github.com/acme/api/pull/123'
    expect([...references(pr, TICKET)]).toEqual([
      ['#123', pr],
      ['API-123', TICKET],
    ])
  })
})

describe('sameReferences', () => {
  it('holds for the same references, made anew or not, and not for any other', () => {
    expect(sameReferences(TASK, TASK)).toBe(true)
    expect(sameReferences(TASK, references(ISSUE_501, PR_511, TICKET))).toBe(true)
    expect(sameReferences(NO_REFERENCES, new Map())).toBe(true)
    // One fewer, one at another address, and one by another name.
    expect(sameReferences(TASK, references(ISSUE_501, PR_511))).toBe(false)
    expect(sameReferences(references(PR_511), references('https://github.com/acme/web/pull/511'))).toBe(false)
    expect(sameReferences(references(PR_511), references(ISSUE_501))).toBe(false)
  })
})

describe('todoSegments', () => {
  it('links `PR #511` whole, `#501` alone and a ticket’s key, each to the task’s own link', () => {
    expect(todoSegments('Watch CI on PR #511 until it’s green', TASK)).toEqual<Segment[]>([
      { kind: SegmentKind.Text, text: 'Watch CI on ' },
      { kind: SegmentKind.Link, text: 'PR #511', href: PR_511 },
      { kind: SegmentKind.Text, text: ' until it’s green' },
    ])
    expect(todoSegments('#501 Return Retry-After on 429s', TASK)).toEqual<Segment[]>([
      { kind: SegmentKind.Link, text: '#501', href: ISSUE_501 },
      { kind: SegmentKind.Text, text: ' Return Retry-After on 429s' },
    ])
    expect(todoSegments('Close API-123', TASK)).toEqual<Segment[]>([
      { kind: SegmentKind.Text, text: 'Close ' },
      { kind: SegmentKind.Link, text: 'API-123', href: TICKET },
    ])
    expect(read('PR#511')).toEqual(['[PR#511]'])
    expect(read('#511')).toEqual(['[#511]'])
  })

  it('leaves what the task has no link for as text: another number, another key, any reference in a task with none', () => {
    expect(read('Watch CI on PR #512, then close API-124 and #50')).toEqual([
      'Watch CI on PR #512, then close API-124 and #50',
    ])
    expect(read('Watch CI on PR #511', NO_REFERENCES)).toEqual(['Watch CI on PR #511'])
    expect(read('', NO_REFERENCES)).toEqual([''])
    expect(read('')).toEqual([''])
  })

  it('matches a whole number only: `#5` beside `#51` and `#511`', () => {
    const five = 'https://github.com/acme/api/issues/5'
    const fiftyOne = 'https://github.com/acme/api/issues/51'
    expect(links('#5, #51 and #511', references(five, fiftyOne, PR_511))).toEqual([
      ['#5', five],
      ['#51', fiftyOne],
      ['#511', PR_511],
    ])
    expect(read('#51 #511 #5', references(five))).toEqual(['#51 #511 ', '[#5]'])
    expect(read('#5 #511 #51', references(fiftyOne))).toEqual(['#5 #511 ', '[#51]'])
    expect(read('#5 #51 #5110 #511', references(PR_511))).toEqual(['#5 #51 #5110 ', '[#511]'])
    // A number written with a zero in front isn't the issue's, and neither is one too long to be any issue's.
    expect(read('#0511 #00511 #51100000000000000')).toEqual(['#0511 #00511 #51100000000000000'])
  })

  it('matches a whole key only', () => {
    expect(read('API-1234 API-12 XAPI-123 API-123x API_123 AP-123')).toEqual([
      'API-1234 API-12 XAPI-123 API-123x API_123 AP-123',
    ])
    expect(read('API-123-backport')).toEqual(['[API-123]', '-backport'])
  })

  it('leaves a key in lower case as text: a ticket’s key is in capitals', () => {
    expect(read('Close api-123, Api-123 and aPI-123')).toEqual(['Close api-123, Api-123 and aPI-123'])
    // The address may write it either way; the text may not.
    const lower = references('https://acme.atlassian.net/browse/api-123')
    expect(read('Close API-123, not api-123', lower)).toEqual(['Close ', '[API-123]', ', not api-123'])
  })

  it('leaves a number inside a word as text', () => {
    expect(read('fix#511 #511th x_#511 #511_x é#511 ９#511 retry#511s')).toEqual([
      'fix#511 #511th x_#511 #511_x é#511 ９#511 retry#511s',
    ])
    // `PR` inside a word isn't part of the link, and neither is it in lower case or a space further off.
    expect(read('CPR #511, pr #511, PR  #511')).toEqual(['CPR ', '[#511]', ', pr ', '[#511]', ', PR  ', '[#511]'])
  })

  it('leaves a number or a key inside an address as text, and a URL that is a link already as that link', () => {
    // A bare URL is a link to itself, whole: nothing in it is linked again.
    expect(todoSegments(`See ${PR_511}`, TASK)).toEqual<Segment[]>([
      { kind: SegmentKind.Text, text: 'See ' },
      { kind: SegmentKind.Link, text: PR_511, href: PR_511 },
    ])
    expect(links('https://example.com/issues#511 and https://example.com/API-123/#501')).toEqual([
      ['https://example.com/issues#511', 'https://example.com/issues#511'],
      ['https://example.com/API-123/#501', 'https://example.com/API-123/#501'],
    ])
    // An address that isn't a link by itself: with no scheme, in a query, as an HTML entity, in a branch's name.
    expect(
      read(
        'github.com/acme/api/pull/511 example.com/#511 ?issue=#511 a&#511; ##511 acme.atlassian.net/browse/API-123 ' +
          'fix/API-123 fix-API-123 key=API-123 feature-#511',
      ),
    ).toHaveLength(1)
  })

  it('links a reference next to punctuation, at the start and at the end', () => {
    expect(read('(#511)')).toEqual(['(', '[#511]', ')'])
    expect(read('Merged PR #511.')).toEqual(['Merged ', '[PR #511]', '.'])
    expect(read('#511, #501: done')).toEqual(['[#511]', ', ', '[#501]', ': done'])
    expect(read('“API-123”')).toEqual(['“', '[API-123]', '”'])
    expect(read('CI failed on PR #511 · fixing')).toEqual(['CI failed on ', '[PR #511]', ' · fixing'])
    expect(read('Waiting on CI · PR #511')).toEqual(['Waiting on CI · ', '[PR #511]'])
    expect(read('on\n#511\nnow')).toEqual(['on\n', '[#511]', '\nnow'])
  })

  it('links every reference in a todo with five, and the same one each time it’s named', () => {
    const pr513 = 'https://github.com/acme/api/pull/513'
    const issue502 = 'https://github.com/acme/api/issues/502'
    const all = references(ISSUE_501, issue502, PR_511, pr513, TICKET)
    const text = 'Ship #501 and #502 (PR #511, PR #513) for API-123, then close #501'
    expect(links(text, all)).toEqual([
      ['#501', ISSUE_501],
      ['#502', issue502],
      ['PR #511', PR_511],
      ['PR #513', pr513],
      ['API-123', TICKET],
      ['#501', ISSUE_501],
    ])
  })

  it('finds references among the text’s own links, in order', () => {
    expect(todoSegments('See https://example.com/limits for #501, or ask dev@example.com about PR #511', TASK)).toEqual<
      Segment[]
    >([
      { kind: SegmentKind.Text, text: 'See ' },
      { kind: SegmentKind.Link, text: 'https://example.com/limits', href: 'https://example.com/limits' },
      { kind: SegmentKind.Text, text: ' for ' },
      { kind: SegmentKind.Link, text: '#501', href: ISSUE_501 },
      { kind: SegmentKind.Text, text: ', or ask ' },
      { kind: SegmentKind.Link, text: 'dev@example.com', href: 'mailto:dev@example.com' },
      { kind: SegmentKind.Text, text: ' about ' },
      { kind: SegmentKind.Link, text: 'PR #511', href: PR_511 },
    ])
  })

  it('never loses or adds a character: the segments, joined, are the text', () => {
    const texts = [
      'Watch CI on PR #511 until it’s green',
      '#501#511 PR #511PR #511',
      'PR PR #511 API-123API-123 #',
      `${PR_511} #511 <${ISSUE_501}> #501 \`#511\``,
      '  #511  ',
      '# 511, PR 511, PR-511, #-511, API-, -123, A-1',
      '🙂 #511 🙂 API-123 🙂',
    ]
    for (const text of texts) {
      expect(
        todoSegments(text, TASK)
          .map((segment) => segment.text)
          .join(''),
      ).toBe(text)
    }
    expect(read('🙂 #511 🙂 API-123 🙂')).toEqual(['🙂 ', '[#511]', ' 🙂 ', '[API-123]', ' 🙂'])
  })

  it('reads a long line with no reference in it without trouble', () => {
    const long = `${'A'.repeat(20_000)} ${'#'.repeat(20_000)} ${'PR '.repeat(10_000)}`
    const started = performance.now()
    expect(read(long)).toEqual([long])
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('namedBy', () => {
  it('is the references a todo’s title and status line name, of those the task has', () => {
    const named = namedBy({ text: '#501 Return Retry-After on 429s', note: 'CI failed on PR #511 · fixing' }, TASK)
    expect([...named]).toEqual([
      ['#501', ISSUE_501],
      ['#511', PR_511],
    ])
    expect([...namedBy({ text: 'Close API-123 (API-123)', note: null }, TASK)]).toEqual([['API-123', TICKET]])
  })

  it('is the one empty value for a todo that names none, and for a task with nothing to name', () => {
    expect(namedBy({ text: 'Draft the 2.5 release notes', note: null }, TASK)).toBe(NO_REFERENCES)
    expect(namedBy({ text: 'Watch PR #512', note: 'fix#511' }, TASK)).toBe(NO_REFERENCES)
    expect(namedBy({ text: 'Watch PR #511', note: null }, NO_REFERENCES)).toBe(NO_REFERENCES)
  })

  it('gives each of 100 todos its own, from a task with 100 links', () => {
    const urls = Array.from({ length: 100 }, (_, index) => `https://github.com/acme/api/pull/${String(index + 1)}`)
    const all = linkReferences(urls.join('\n'))
    expect(all.size).toBe(100)
    const named = urls.map((_, index) => namedBy({ text: `Review PR #${String(index + 1)}`, note: null }, all))
    expect(named.map((each) => [...each])).toEqual(urls.map((url, index) => [[`#${String(index + 1)}`, url]]))
  })
})
