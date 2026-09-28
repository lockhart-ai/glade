// Marking pasted text for the agent (#363, from the Opus 5.5 prompting guide): a host that wraps pasted text lets the
// model resist prompt injection inside it. A big paste (more than one line, or ~80 characters or more) becomes a
// pasted block: an inline token stands for it among the typed text, atomic (it deletes as a unit) and never itself
// carrying the block's id, since a block is matched to its token by position, not by its text. `docs/model-surface.md`
// says how the agent receives it.
import type { PastedBlock } from './domain'

/** Below this, a paste is left as plain typed text: a path, a word or a URL isn't worth marking. */
export const PASTE_LENGTH_THRESHOLD = 80

/** Comfortably past anything worth pasting; guards the request schema, not a limit anyone should reach in practice. */
export const MAX_PASTED_BLOCK_LENGTH = 200_000

/** A pasted text's line count, a single trailing newline (common when copying a line) not counted as a second one. */
export function pastedLineCount(text: string): number {
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.split('\n').length
}

/** Whether a paste is worth marking as its own block: more than one line, or `PASTE_LENGTH_THRESHOLD` characters or more. */
export function isPasteWorthMarking(text: string): boolean {
  return pastedLineCount(text) > 1 || text.length >= PASTE_LENGTH_THRESHOLD
}

/** The inline token that stands for a pasted block among typed text, e.g. `[Pasted text · 42 lines]`. */
export function pasteToken(text: string): string {
  const lines = pastedLineCount(text)
  return `[Pasted text · ${String(lines)} line${lines === 1 ? '' : 's'}]`
}

/**
 * Matches every pasted-block token in typed text, in order. A token never carries its block's id or text: it's
 * matched to `PastedBlock[]` by position (its Nth match is `blocks[N]`), so two blocks of the same length read the
 * same but are still told apart.
 */
export const PASTE_TOKEN_PATTERN = /\[Pasted text · \d+ lines?\]/g

/** A span of text, as a character range: `text.slice(start, end)`. */
export interface TextRange {
  readonly start: number
  readonly end: number
}

/** Every pasted-block token's character range in typed text, in order (for highlighting it in the input). */
export function pasteTokenRanges(text: string): TextRange[] {
  return [...text.matchAll(PASTE_TOKEN_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

/** A run of typed text, or a pasted block, in the order they make up a message. */
export type MessageSegment =
  { readonly kind: 'typed'; readonly text: string } | { readonly kind: 'pasted'; readonly block: PastedBlock }

/**
 * Splits typed text carrying inline pasted-block tokens into its segments, in order, matching each token to its
 * block by position. A token with no block left for it (more tokens than blocks; shouldn't happen with well-formed
 * data) is kept as plain text rather than silently dropped.
 */
export function messageSegments(body: string, blocks: readonly PastedBlock[]): MessageSegment[] {
  const segments: MessageSegment[] = []
  let last = 0
  let index = 0
  for (const match of body.matchAll(PASTE_TOKEN_PATTERN)) {
    const start = match.index
    if (start > last) segments.push({ kind: 'typed', text: body.slice(last, start) })
    const block = blocks[index]
    segments.push(block === undefined ? { kind: 'typed', text: match[0] } : { kind: 'pasted', block })
    index += 1
    last = start + match[0].length
  }
  if (last < body.length || segments.length === 0) segments.push({ kind: 'typed', text: body.slice(last) })
  return segments
}

/** How the agent takes a pasted block: from the Opus 5.5 prompting guide, `docs/model-surface.md`. */
export function wrapPastedBlock(block: PastedBlock): string {
  return `<pasted_content id="${block.id}">\n${block.text}\n</pasted_content id="${block.id}">`
}

/**
 * The text handed to the agent: typed text as usual, with each pasted block wrapped at its place among it
 * (`docs/model-surface.md`).
 */
export function agentText(body: string, blocks: readonly PastedBlock[]): string {
  return messageSegments(body, blocks)
    .map((segment) => (segment.kind === 'typed' ? segment.text : wrapPastedBlock(segment.block)))
    .join('')
}

/** The alphabet a pasted block's id is drawn from: lowercase letters and digits, so it reads as a short, plain code. */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** Long enough that two blocks in the same task are never given the same id in practice. */
const ID_LENGTH = 6

/** What a pasted block's id looks like: lowercase letters and digits, 4 to 12 of them (the request schema checks it). */
export const PASTE_ID_PATTERN = /^[a-z0-9]{4,12}$/

/** A short random id for a new pasted block, for its tag (`docs/model-surface.md`) — never shown in the UI. */
export function randomPasteId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH))
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i += 1
  return i
}

function commonSuffixLength(a: string, b: string, limit: number): number {
  const max = Math.min(a.length, b.length) - limit
  let i = 0
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1
  return i
}

/**
 * Keeps `blocks` in step with a plain edit to typed text (backspacing into a token, typing over a selection that
 * covers one, …): the edit is left to do whatever it does to the text; this drops any block whose token didn't
 * survive it wholly outside the edited span, so a mangled token never keeps pointing at a block.
 */
export function reconcilePastedBlocks(
  oldText: string,
  newText: string,
  blocks: readonly PastedBlock[],
): readonly PastedBlock[] {
  if (blocks.length === 0) return blocks
  const spans = [...oldText.matchAll(PASTE_TOKEN_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
  const prefix = commonPrefixLength(oldText, newText)
  const suffix = commonSuffixLength(oldText, newText, prefix)
  const changedStart = prefix
  const changedEnd = oldText.length - suffix
  const kept = blocks.filter((_, index) => {
    const span = spans[index]
    return span !== undefined && (span.end <= changedStart || span.start >= changedEnd)
  })
  return kept.length === blocks.length ? blocks : kept
}

/** A pasted block's index among `blocks`, or -1 when it isn't one of them (any more). */
function indexOfBlock(blocks: readonly PastedBlock[], id: string): number {
  return blocks.findIndex((block) => block.id === id)
}

/** Typed text with a new pasted block's token spliced in at `start`–`end` (the caret, or the selection it replaces). */
export interface PastedBlockInsertion {
  readonly text: string
  readonly blocks: readonly PastedBlock[]
  /** Where the caret goes next: right after the inserted token. */
  readonly caret: number
}

/** Inserts a new pasted block at a position in typed text, keeping `blocks` in the same order as their tokens. */
export function insertPastedBlock(
  text: string,
  blocks: readonly PastedBlock[],
  start: number,
  end: number,
  pastedText: string,
): PastedBlockInsertion {
  const token = pasteToken(pastedText)
  const nextText = text.slice(0, start) + token + text.slice(end)
  const before = [...text.slice(0, start).matchAll(PASTE_TOKEN_PATTERN)].length
  const block: PastedBlock = { id: randomPasteId(), text: pastedText }
  return {
    text: nextText,
    blocks: [...blocks.slice(0, before), block, ...blocks.slice(before)],
    caret: start + token.length,
  }
}

/** Typed text and blocks with one pasted block, and its token, removed — wherever it is. */
export interface PastedBlockEdit {
  readonly text: string
  readonly blocks: readonly PastedBlock[]
}

/** Removes a pasted block and its token from typed text, by its id. Does nothing when it isn't there (any more). */
export function removePastedBlock(text: string, blocks: readonly PastedBlock[], id: string): PastedBlockEdit {
  const index = indexOfBlock(blocks, id)
  if (index === -1) return { text, blocks }
  const match = [...text.matchAll(PASTE_TOKEN_PATTERN)][index]
  const nextText = match === undefined ? text : text.slice(0, match.index) + text.slice(match.index + match[0].length)
  return { text: nextText, blocks: blocks.filter((block) => block.id !== id) }
}

/** Changes a pasted block's text, by its id, regenerating its token in place (its line count may have changed). */
export function updatePastedBlock(
  text: string,
  blocks: readonly PastedBlock[],
  id: string,
  nextText: string,
): PastedBlockEdit {
  const index = indexOfBlock(blocks, id)
  if (index === -1) return { text, blocks }
  const match = [...text.matchAll(PASTE_TOKEN_PATTERN)][index]
  const token = pasteToken(nextText)
  const replaced =
    match === undefined ? text : text.slice(0, match.index) + token + text.slice(match.index + match[0].length)
  return { text: replaced, blocks: blocks.map((block) => (block.id === id ? { ...block, text: nextText } : block)) }
}

/** A token's span, and which of `blocks` (by position) it stands for. */
export interface TokenSpan {
  readonly start: number
  readonly end: number
  readonly block: PastedBlock
}

/** A token's span ending exactly at `pos` (for atomic Backspace right after it), if there is one. */
export function tokenEndingAt(text: string, blocks: readonly PastedBlock[], pos: number): TokenSpan | null {
  let index = 0
  for (const match of text.matchAll(PASTE_TOKEN_PATTERN)) {
    const end = match.index + match[0].length
    const block = blocks[index]
    index += 1
    if (end === pos && block !== undefined) return { start: match.index, end, block }
  }
  return null
}

/** A token's span starting exactly at `pos` (for atomic Delete right before it), if there is one. */
export function tokenStartingAt(text: string, blocks: readonly PastedBlock[], pos: number): TokenSpan | null {
  let index = 0
  for (const match of text.matchAll(PASTE_TOKEN_PATTERN)) {
    const start = match.index
    const block = blocks[index]
    index += 1
    if (start === pos && block !== undefined) return { start, end: start + match[0].length, block }
  }
  return null
}
