import type { Element } from 'hast'
import { describe, expect, it } from 'vitest'
import { highlightPattern } from '../../shared/search'
import { hastText, linkedSegments, linkSegments, linkTitle, SegmentKind, type Segment } from './linkify'

/** A segment of text. */
function text(value: string): Segment {
  return { kind: SegmentKind.Text, text: value }
}

/** A link segment, its text and the address that opens. */
function link(value: string, href: string = value): Segment {
  return { kind: SegmentKind.Link, text: value, href }
}

describe('linkSegments', () => {
  it('finds the bare URLs, www. addresses and email addresses in plain text', () => {
    expect(
      linkSegments('Docs at https://example.com/docs, status on www.example.com; mail support@example.com today'),
    ).toEqual([
      text('Docs at '),
      link('https://example.com/docs'),
      text(', status on '),
      link('www.example.com', 'http://www.example.com/'),
      text('; mail '),
      link('support@example.com', 'mailto:support@example.com'),
      text(' today'),
    ])
  })

  it('opens each as the URL parser writes it out', () => {
    expect(linkSegments('HTTPS://Example.COM/Docs http://localhost:4173')).toEqual([
      link('HTTPS://Example.COM/Docs', 'https://example.com/Docs'),
      text(' '),
      link('http://localhost:4173', 'http://localhost:4173/'),
    ])
  })

  it('leaves trailing punctuation out of a link, but keeps balanced brackets in it', () => {
    expect(
      linkSegments('See https://example.com/docs. Or (https://example.com/a_(b)) or https://example.com/q?x=1!'),
    ).toEqual([
      text('See '),
      link('https://example.com/docs'),
      text('. Or ('),
      link('https://example.com/a_(b)'),
      text(') or '),
      link('https://example.com/q?x=1'),
      text('!'),
    ])
  })

  it('keeps a query and a fragment', () => {
    expect(linkSegments('https://example.com/search?q=rate+limits&page=2#results')).toEqual([
      link('https://example.com/search?q=rate+limits&page=2#results'),
    ])
  })

  it('finds links on every line of multi-line text, such as a tool’s output', () => {
    expect(linkSegments('Preview at http://localhost:4173\nDeployed to https://example.com/app\n')).toEqual([
      text('Preview at '),
      link('http://localhost:4173', 'http://localhost:4173/'),
      text('\nDeployed to '),
      link('https://example.com/app'),
      text('\n'),
    ])
  })

  it('reads nothing else in the text as Markdown, bar a code span, whose URL stays plain', () => {
    expect(
      linkSegments(
        'Run `open https://example.com/x`, see [the docs](https://example.com/docs) or <https://example.com/a>, ' +
          '**https://example.com/b** and _https://example.com/c_',
      ),
    ).toEqual([
      text('Run `open https://example.com/x`, see [the docs]('),
      link('https://example.com/docs'),
      text(') or <'),
      link('https://example.com/a'),
      text('>, **'),
      link('https://example.com/b'),
      text('** and _'),
      link('https://example.com/c'),
      text('_'),
    ])
  })

  it('finds links in indented lines, escapes and after list markers, which plain text doesn’t read', () => {
    expect(
      linkSegments(
        '    https://example.com/indented\n- https://example.com/item\n' +
          '# https://example.com/heading\n\\https://example.com/escaped &amp; https://example.com/q?a=1&amp;b=2',
      ).filter((segment) => segment.kind === SegmentKind.Link),
    ).toEqual([
      link('https://example.com/indented'),
      link('https://example.com/item'),
      link('https://example.com/heading'),
      link('https://example.com/escaped'),
      link('https://example.com/q?a=1&amp;b=2', 'https://example.com/q?a=1&amp;b=2'),
    ])
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hi',
    'ftp://example.com/file',
    'glade://task/t1',
    'example.com',
    'localhost:4173',
    'user@localhost',
  ])('links nothing in %j', (source) => {
    expect(linkSegments(`before ${source} after`)).toEqual([text(`before ${source} after`)])
  })

  it('leaves the addresses in an HTML tag alone, linking the text between tags', () => {
    expect(linkSegments('<a href="https://example.com/html">https://example.com/text</a>')).toEqual([
      text('<a href="https://example.com/html">'),
      link('https://example.com/text'),
      text('</a>'),
    ])
  })

  it('links a host without a dot when it has a scheme, as GitHub does', () => {
    expect(linkSegments('https://localhost')).toEqual([link('https://localhost', 'https://localhost/')])
  })

  it('needs a link to start a word', () => {
    expect(linkSegments('xhttps://example.com and foohttps://example.com')).toEqual([
      text('xhttps://example.com and foohttps://example.com'),
    ])
  })

  it('answers with one segment of text for text without links, even none', () => {
    expect(linkSegments('Copy the 3,900 existing files')).toEqual([text('Copy the 3,900 existing files')])
    expect(linkSegments('')).toEqual([text('')])
  })

  it.each([
    'Docs at https://example.com/docs, status on www.example.com; mail support@example.com today',
    'See https://example.com/docs. Or (https://example.com/a_(b)) or https://example.com/q?x=1!',
    'https://example.com https://example.com https://example.com',
    'Café → https://example.com/ünïcode?q=日本 ✓',
  ])('keeps every character of %j, in order', (source) => {
    expect(
      linkSegments(source)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(source)
  })
})

describe('linkedSegments', () => {
  it('marks what the search matches, in the text and the links alike', () => {
    expect(linkedSegments('Read the docs: https://example.com/docs', highlightPattern('docs'))).toEqual([
      {
        kind: SegmentKind.Text,
        parts: [
          { text: 'Read the ', match: false },
          { text: 'docs', match: true },
          { text: ': ', match: false },
        ],
      },
      {
        kind: SegmentKind.Link,
        text: 'https://example.com/docs',
        href: 'https://example.com/docs',
        parts: [
          { text: 'https://example.com/', match: false },
          { text: 'docs', match: true },
        ],
      },
    ])
  })

  it('marks a match that runs into a link on both sides of its edge', () => {
    const [before, into] = linkedSegments('see https://example.com', highlightPattern('see https'))

    expect(before).toEqual({ kind: SegmentKind.Text, parts: [{ text: 'see ', match: true }] })
    expect(into).toMatchObject({
      kind: SegmentKind.Link,
      parts: [
        { text: 'https', match: true },
        { text: '://example.com', match: false },
      ],
    })
  })

  it('marks nothing with no search', () => {
    expect(linkedSegments('https://example.com', null)).toEqual([
      {
        kind: SegmentKind.Link,
        text: 'https://example.com',
        href: 'https://example.com/',
        parts: [{ text: 'https://example.com', match: false }],
      },
    ])
    expect(linkedSegments('', null)).toEqual([{ kind: SegmentKind.Text, parts: [] }])
  })
})

describe('linkTitle', () => {
  it('shows the address when the text says something else', () => {
    expect(linkTitle('the docs', 'https://example.com/docs')).toBe('https://example.com/docs')
    expect(linkTitle('https://example.com/other', 'https://example.com/docs')).toBe('https://example.com/docs')
    expect(linkTitle('', 'https://example.com/docs')).toBe('https://example.com/docs')
  })

  it('shows nothing when the text is the address', () => {
    expect(linkTitle('https://example.com/docs', 'https://example.com/docs')).toBeUndefined()
    expect(linkTitle('https://example.com', 'https://example.com/')).toBeUndefined()
    expect(linkTitle(' HTTPS://Example.com ', 'https://example.com/')).toBeUndefined()
    expect(linkTitle('www.example.com', 'http://www.example.com/')).toBeUndefined()
    expect(linkTitle('support@example.com', 'mailto:support@example.com')).toBeUndefined()
  })
})

describe('hastText', () => {
  it('is the text of a node and everything in it', () => {
    const node: Element = {
      type: 'element',
      tagName: 'a',
      properties: {},
      children: [
        { type: 'text', value: 'the ' },
        { type: 'element', tagName: 'mark', properties: {}, children: [{ type: 'text', value: 'docs' }] },
        { type: 'comment', value: 'nothing' },
      ],
    }
    expect(hastText(node)).toBe('the docs')
  })
})
