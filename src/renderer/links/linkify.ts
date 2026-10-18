/**
 * Finding the links in text: the bare URLs, `www.` addresses and email addresses GitHub's Markdown links on its own
 * (GFM's autolink literals). The chat's Markdown finds them with remark-gfm; a tool log note and plain text (a todo,
 * your message, a tool's output) use the same extensions, so a link is a link wherever it's shown.
 */
import type { Element, ElementContent } from 'hast'
import type { Root } from 'mdast'
import { fromMarkdown, type Options as FromMarkdownOptions } from 'mdast-util-from-markdown'
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal'
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal'
// The types of the parser's extensions on a processor's data, which remark-parse registers.
import type {} from 'remark-parse'
import type { Processor } from 'unified'
import { openableUrl } from '../../shared/links'
import { highlightParts, type TextPart } from '../../shared/search'

type MicromarkExtension = NonNullable<FromMarkdownOptions['extensions']>[number]
type MdastExtension = NonNullable<FromMarkdownOptions['mdastExtensions']>[number]

/**
 * A remark plugin for GFM's autolink literals alone, without the rest of GFM (its tables, task lists and
 * strikethrough): the same extensions remark-gfm adds for them, to the parser's (`remark-parse` reads them).
 */
export function remarkAutolinkLiterals(this: Processor): void {
  const data = this.data()
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), gfmAutolinkLiteral()]
  data.fromMarkdownExtensions = [...(data.fromMarkdownExtensions ?? []), gfmAutolinkLiteralFromMarkdown()]
}

/**
 * Plain text is read with Markdown turned off but for what marks a URL out: a code span, whose URL stays plain as in a
 * reply; an HTML tag, whose attributes aren't linked (a tool's output may be HTML); and `<https://…>`, linked without
 * its brackets. Anything else (`[x](y)`, `*`, `\`, `&amp;`, indentation, list and heading marks) is just characters,
 * and hides no link.
 */
const PLAIN_TEXT: MicromarkExtension = {
  disable: {
    null: [
      'attention',
      'blockQuote',
      'characterEscape',
      'characterReference',
      'codeFenced',
      'codeIndented',
      'definition',
      'hardBreakEscape',
      'headingAtx',
      'htmlFlow',
      'labelEnd',
      'labelStartImage',
      'labelStartLink',
      'list',
      'setextUnderline',
      'thematicBreak',
    ],
  },
}

/**
 * The links' syntax tree nodes, without the pass that finds more in the text afterwards: every link then comes from
 * the tokenizer, with where it is in the text.
 */
const PLAIN_TEXT_LINKS: MdastExtension = { ...gfmAutolinkLiteralFromMarkdown(), transforms: [] }

export enum SegmentKind {
  Text = 'text',
  Link = 'link',
  Todo = 'todo',
}

/**
 * A stretch of text, or a link in it that Glade opens: `href` is what opens, `text` what the text says. A `todo:` link
 * (`[any text](todo:N)`, #684) is its own kind: it shows a todo in the Todos tab, not the browser.
 */
export type Segment =
  | { readonly kind: SegmentKind.Text; readonly text: string }
  | { readonly kind: SegmentKind.Link; readonly text: string; readonly href: string }
  | { readonly kind: SegmentKind.Todo; readonly text: string; readonly todoId: string }

/** Where a link is in the text, and the address that opens. */
interface FoundLink {
  readonly start: number
  readonly end: number
  readonly href: string
}

/**
 * The links Glade opens in a tree of plain text, in order, where they are in it: where their text is, which leaves out
 * the brackets of `<https://…>`.
 */
function foundLinks(tree: Root): FoundLink[] {
  return tree.children
    .flatMap((block) => (block.type === 'paragraph' ? block.children : []))
    .flatMap((node) => {
      const shown = node.type === 'link' ? node.children[0]?.position : undefined
      const href = node.type === 'link' ? openableUrl(node.url) : null
      return href !== null && shown !== undefined ? [{ start: shown.start.offset, end: shown.end.offset, href }] : []
    })
    .flatMap(({ start, end, href }) => (start === undefined || end === undefined ? [] : [{ start, end, href }]))
}

/** Where a `todo:` link is in the text, and the todo it names. */
interface FoundTodo {
  readonly start: number
  readonly end: number
  readonly todoId: string
}

/** What marks a `todo:` link out in plain text: `[any text](todo:N)`, with the todo's id (#684). */
const TODO_LINK = /\[[^\]\n]+\]\(todo:([1-9][0-9]*)\)/g

/** Where the text keeps an inline code span, whose contents stay plain: a `todo:` link in one is just characters. */
function codeSpans(tree: Root): FoundLink[] {
  return tree.children
    .flatMap((block) => (block.type === 'paragraph' ? block.children : []))
    .flatMap((node) => {
      const { position } = node
      return node.type === 'inlineCode' && position !== undefined
        ? [{ start: position.start.offset ?? 0, end: position.end.offset ?? 0, href: '' }]
        : []
    })
}

/**
 * The `todo:` links in the text, in order, where they are in it: none inside an inline code span. The plain-text
 * parser keeps the link's brackets as characters, so they're found in the text itself.
 */
function foundTodos(text: string, spans: readonly FoundLink[]): FoundTodo[] {
  const found: FoundTodo[] = []
  for (const match of text.matchAll(TODO_LINK)) {
    const start = match.index
    const end = start + match[0].length
    if (spans.some((span) => span.start < end && start < span.end)) continue
    found.push({ start, end, todoId: match[1] ?? '' })
  }
  return found
}

/**
 * Plain text split into its links and the text around them, in order: the segments' text, joined, is `text`. Only a
 * link Glade opens (`openableUrl`) is a link, and a `todo:` link (`[any text](todo:N)`, #684) is a link to a todo.
 * Nothing else in the text is Markdown.
 */
export function linkSegments(text: string): Segment[] {
  const tree = fromMarkdown(text, {
    extensions: [gfmAutolinkLiteral(), PLAIN_TEXT],
    mdastExtensions: [PLAIN_TEXT_LINKS],
  })
  const todos = foundTodos(text, codeSpans(tree))
  const found = [
    ...foundLinks(tree).map(({ start, end, href }) => ({ start, end, href, todoId: null })),
    ...todos.map(({ start, end, todoId }) => ({ start, end, href: null, todoId })),
  ].sort((one, other) => one.start - other.start)
  const segments: Segment[] = []
  let at = 0
  for (const { start, end, href, todoId } of found) {
    // The two finds never overlap, but a URL the parser links inside a todo link's text would: the todo link, which
    // starts first, wins.
    if (start < at) continue
    if (start > at) segments.push({ kind: SegmentKind.Text, text: text.slice(at, start) })
    if (todoId === null) segments.push({ kind: SegmentKind.Link, text: text.slice(start, end), href })
    else segments.push({ kind: SegmentKind.Todo, text: text.slice(start, end), todoId })
    at = end
  }
  if (at < text.length || segments.length === 0) segments.push({ kind: SegmentKind.Text, text: text.slice(at) })
  return segments
}

/** A segment of text with what the search marks in it (`TextPart`s, joined, are its text). */
export type LinkedSegment =
  | { readonly kind: SegmentKind.Text; readonly parts: readonly TextPart[] }
  | {
      readonly kind: SegmentKind.Link
      readonly text: string
      readonly href: string
      readonly parts: readonly TextPart[]
    }
  | {
      readonly kind: SegmentKind.Todo
      readonly text: string
      readonly todoId: string
      readonly parts: readonly TextPart[]
    }

/** The stretch of `parts` from `start` to `end`, counted in the characters of the text they make up. */
function sliceParts(parts: readonly TextPart[], start: number, end: number): TextPart[] {
  const sliced: TextPart[] = []
  let at = 0
  for (const part of parts) {
    const from = Math.max(start, at)
    const to = Math.min(end, at + part.text.length)
    if (from < to) sliced.push({ text: part.text.slice(from - at, to - at), match: part.match })
    at += part.text.length
  }
  return sliced
}

/**
 * Plain text split into its links and the text around them, with what `pattern` (the sidebar's search, from
 * `highlightPattern`) matches marked in each. A match is found in the whole text, so one that runs into a link is
 * marked on both sides of its edge.
 */
export function linkedSegments(text: string, pattern: RegExp | null): LinkedSegment[] {
  const marked = highlightParts(text, pattern)
  let at = 0
  return linkSegments(text).map((segment): LinkedSegment => {
    const parts = sliceParts(marked, at, at + segment.text.length)
    at += segment.text.length
    switch (segment.kind) {
      case SegmentKind.Text:
        return { kind: SegmentKind.Text, parts }
      case SegmentKind.Link:
      case SegmentKind.Todo:
        return { ...segment, parts }
    }
  })
}

/** A hast node's text: a rendered Markdown link's, for its tooltip. */
export function hastText(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value
  return node.type === 'element' ? node.children.map(hastText).join('') : ''
}

/**
 * What a link's tooltip says: its address, when its text says something else (`[the docs](https://…)`), and nothing when
 * its text is its address, as a bare URL or email address is.
 */
export function linkTitle(text: string, href: string): string | undefined {
  const shown = text.trim()
  const same = [shown, `http://${shown}`, `mailto:${shown}`].some((address) => openableUrl(address) === href)
  return same ? undefined : href
}
