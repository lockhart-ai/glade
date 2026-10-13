/**
 * The PRs, issues and tickets a todo's text names (P16, #500). Where a todo's
 * title or status line says `PR #511`, `#511` or a Jira key such as `API-123`, and the task has that very PR, issue or
 * ticket as a link artifact, those words are a link to it. Only an exact match on the number or key, only to a link the
 * task itself has, and nothing is fetched: what a link is comes from its address alone (`recogniseLink`).
 *
 * The hub works a task's references out once per change of its links (`linkAddresses`, `linkReferences`), and gives
 * each todo's card only the ones its own text names (`namedBy`): a link added or removed renders the cards that name
 * it, and no other. Pure, so it's tested on its own.
 */
import { linkLabel, LinkKind, recogniseLink, type RecognisedLink } from '../../shared/artifactLinks'
import { ArtifactKind, type Artifact, type Todo } from '../../shared/domain'
import { linkSegments, SegmentKind, type Segment } from '../links'

/** A link that names something: a PR, an issue or a ticket (a link to any other page has nothing to be named by). */
type NamedLink = Extract<RecognisedLink, { kind: LinkKind.PullRequest | LinkKind.Issue | LinkKind.Ticket }>

/**
 * What a todo's text may name, each with the address it opens: a PR or issue by its number as it's written (`#511`),
 * a ticket by its key (`API-123`).
 */
export type LinkReferences = ReadonlyMap<string, string>

/** No references: a task with no PR, issue or ticket among its links, and a todo that names none. */
export const NO_REFERENCES: LinkReferences = new Map<string, string>()

/**
 * The addresses of a task's link artifacts, one to a line (no address has a line break in it: `checkArtifactUrl`). One
 * value that stays the same while the task's links do, however often its artifacts arrive anew (main sends them all
 * again when one file changes), so the references are worked out once per change of the links.
 */
export function linkAddresses(artifacts: readonly Artifact[]): string {
  return artifacts.flatMap((artifact) => (artifact.kind === ArtifactKind.Link ? [artifact.url] : [])).join('\n')
}

/**
 * What a todo of the task may name, from its links' addresses (`linkAddresses`): each PR, issue and ticket among them,
 * by its number or key. Links to the same thing count as one: a comment on an issue, or a PR's Files page, is that
 * issue or PR, and the number links to the thing's own page (no fragment, query or sub-page), preferring a link that
 * is already that address. A name that links to different things share (the same number in two repositories, an issue
 * and a PR, or one key on two Jiras) names neither, so it stays plain text. A link to any other page has nothing to
 * be named by.
 */
export function linkReferences(addresses: string): LinkReferences {
  /** Each name's links so far, or null once a second link to a different thing has the name. */
  const found = new Map<string, { target: string; links: (readonly [string, NamedLink])[] } | null>()
  for (const url of addresses === '' ? [] : addresses.split('\n')) {
    const link = recogniseLink(url)
    if (link.kind === LinkKind.Web) continue
    const named: NamedLink = link
    const name = linkLabel(named)
    const target = targetOf(url, named)
    const entry = found.get(name)
    if (entry === undefined) found.set(name, { target, links: [[url, named]] })
    else if (entry !== null && entry.target === target) entry.links.push([url, named])
    else found.set(name, null)
  }
  const references = new Map<string, string>()
  for (const [name, entry] of found) {
    if (entry !== null) references.set(name, ownAddress(entry.links))
  }
  return references.size === 0 ? NO_REFERENCES : references
}

/**
 * What two links name the same of, as `recogniseLink` reads it: a PR or issue's kind, repository and number, or a
 * ticket's host and key (the same key on two Jiras is two tickets). A fragment, a query or a sub-page of a PR or
 * issue isn't part of it, so a comment on an issue names that issue.
 */
function targetOf(url: string, link: NamedLink): string {
  switch (link.kind) {
    case LinkKind.PullRequest:
    case LinkKind.Issue:
      return `${link.kind} ${link.repo}/${String(link.number)}`
    case LinkKind.Ticket:
      return `${link.kind} ${new URL(url).host}/${link.key}`
  }
}

/** The thing's own page: a PR or issue's plain address (no fragment, query or sub-page), or a ticket's page. */
function plainAddress(url: string, link: NamedLink): string {
  const parsed = new URL(url)
  switch (link.kind) {
    case LinkKind.PullRequest:
    case LinkKind.Issue:
      return `${parsed.origin}/${link.repo}/${link.kind === LinkKind.PullRequest ? 'pull' : 'issues'}/${String(link.number)}`
    case LinkKind.Ticket:
      return parsed.origin + parsed.pathname.replace(/\/$/, '')
  }
}

/**
 * The address the name opens: a link that is already the thing's own page, as it is; otherwise its own page, built
 * from the first link's parts.
 */
function ownAddress(links: readonly (readonly [string, NamedLink])[]): string {
  /** The first link's own page, kept for when none of the links is already at it. */
  let built: string | undefined
  for (const [url, link] of links) {
    const plain = plainAddress(url, link)
    if (url === plain) return plain
    built ??= plain
  }
  return built ?? ''
}

/** Whether two sets of references name the same things, at the same addresses. */
export function sameReferences(a: LinkReferences, b: LinkReferences): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [name, url] of a) {
    if (b.get(name) !== url) return false
  }
  return true
}

/**
 * A reference as text writes it: `#511` (with `PR ` before it, which is then part of the link, as the screens draw
 * it), or a Jira key in capitals, as Jira writes it (`API-123`; `api-123` is left as text). It has to stand on its own.
 * Straight before it there's no letter, digit or `_` (inside a word: `fix#511`, `XAPI-123`), and no `/`, `#`, `=`, `&`
 * or `-` (inside an address, an HTML entity or a branch name: `pull/#511`, `&#511;`, `fix-API-123`). Straight after it
 * there's no letter, digit or `_`, so `#5` isn't found in `#51`, nor `API-12` in `API-123`. A number starts from 1 to
 * 9, as an issue's does (`#0511` is no reference).
 */
const REFERENCE = /(?<![\p{L}\p{N}_/#=&-])(?:(?:PR ?)?(#[1-9]\d{0,15})|([A-Z][A-Z0-9_]*-[1-9]\d*))(?![\p{L}\p{N}_])/gu

/** A reference found in text: where it is, what it names, and the address that opens. */
interface FoundReference {
  /** Where its words start and end in the text, `PR ` included. */
  readonly start: number
  readonly end: number
  /** What it names, as `LinkReferences` has it: `#511`, `API-123`. */
  readonly name: string
  readonly href: string
}

/** The references in `text` that name one of `references`, in order. One that names nothing the task has isn't one. */
function referencesIn(text: string, references: LinkReferences): FoundReference[] {
  const found: FoundReference[] = []
  for (const match of text.matchAll(REFERENCE)) {
    const name = match[1] ?? match[2] ?? ''
    const href = references.get(name)
    if (href !== undefined) found.push({ start: match.index, end: match.index + match[0].length, name, href })
  }
  return found
}

/**
 * The references a todo's title and status line name, of those its task has: all its card needs of them. A todo that
 * names none (most don't) has `NO_REFERENCES` itself, so its card is given the same value every time.
 */
export function namedBy(todo: Pick<Todo, 'text' | 'note'>, references: LinkReferences): LinkReferences {
  if (references.size === 0) return NO_REFERENCES
  const named = new Map<string, string>()
  for (const text of [todo.text, todo.note]) {
    if (text === null) continue
    for (const { name, href } of referencesIn(text, references)) named.set(name, href)
  }
  return named.size === 0 ? NO_REFERENCES : named
}

/**
 * A todo's title or status line split into its links and the text around them, in order (the segments' text, joined,
 * is `text`): the URLs and email addresses that are links in any text (`linkSegments`), and, in the text between
 * them, the references that name one of `references`. A reference is looked for in the whole text, so one inside a
 * URL that is a link already is left to that link.
 */
export function todoSegments(text: string, references: LinkReferences): Segment[] {
  const segments = linkSegments(text)
  const found = references.size === 0 ? [] : referencesIn(text, references)
  if (found.length === 0) return segments
  const split: Segment[] = []
  let at = 0
  for (const segment of segments) {
    const end = at + segment.text.length
    switch (segment.kind) {
      case SegmentKind.Link:
        split.push(segment)
        break
      case SegmentKind.Text: {
        let from = at
        for (const { start, end: stop, href } of found) {
          if (start < from || stop > end) continue
          if (start > from) split.push({ kind: SegmentKind.Text, text: text.slice(from, start) })
          split.push({ kind: SegmentKind.Link, text: text.slice(start, stop), href })
          from = stop
        }
        if (from < end) split.push({ kind: SegmentKind.Text, text: text.slice(from, end) })
        break
      }
    }
    at = end
  }
  return split
}
