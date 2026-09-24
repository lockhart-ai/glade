/**
 * Search over a workspace's tasks (`search.query`), shared by main, which runs it on SQLite's FTS5 index, and the
 * renderer, which highlights the same matches in the task header and chat.
 *
 * What you type is never handed to FTS5 as query syntax. It's split into words at whitespace, and each word into the
 * tokens FTS5's `unicode61` tokenizer would make of it (runs of letters, digits and marks). A word becomes a quoted
 * phrase of its tokens, matched as a prefix so results appear as you type: `Retry-After hea` is `"retry after"*
 * "hea"*`, which finds a field or message with both. Punctuation and FTS5's operators (`AND`, `NEAR`, `*`, `"`, `:`) are just text.
 */

/** Which of a task's fields a search result's snippet comes from. */
export enum SearchField {
  Title = 'title',
  Objective = 'objective',
  /** The task's status; its outcome once it's done. */
  Status = 'status',
  /** A message in its chat log, yours or the agent's. */
  Message = 'message',
}

/** A stretch of a snippet or of highlighted text: a match of the search, or the text around one. */
export interface TextPart {
  readonly text: string
  readonly match: boolean
}

/** One task that matches a search. */
export interface SearchResult {
  readonly taskId: string
  /**
   * The field the snippet comes from: the best match outside the title, or the title when nothing else matches. (The
   * title is shown on the result's row anyway, highlighted.)
   */
  readonly field: SearchField
  /** A few words around the match, with the match marked. Starts or ends with `…` where the field goes on. */
  readonly snippet: readonly TextPart[]
}

/** A run of the characters FTS5's `unicode61` tokenizer keeps in a token. */
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu

/** The search's words, each as its lowercased tokens; words with no token (only punctuation) are dropped. */
export function searchWords(text: string): string[][] {
  return text
    .split(/\s+/u)
    .map((word) => Array.from(word.toLowerCase().matchAll(TOKEN), ([token]) => token))
    .filter((tokens) => tokens.length > 0)
}

/** The FTS5 query for what you typed: each word a quoted prefix phrase, all of them required. Null when it has none. */
export function ftsQuery(text: string): string | null {
  const words = searchWords(text)
  if (words.length === 0) return null
  // Tokens hold only letters, digits and marks, so nothing inside the quotes needs escaping.
  return words.map((tokens) => `"${tokens.join(' ')}"*`).join(' ')
}

const TOKEN_CHAR = '[\\p{L}\\p{N}\\p{M}]'
const NOT_TOKEN_CHAR = '[^\\p{L}\\p{N}\\p{M}]'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A pattern finding what `ftsQuery` matches in plain text, for highlighting: each word's tokens in order, at the start
 * of a token, with anything but a token between them, the last running on to the end of its token (the prefix match).
 * Null when the search has no words.
 */
export function highlightPattern(text: string): RegExp | null {
  const words = searchWords(text)
  if (words.length === 0) return null
  const alternatives = words
    .map((tokens) => tokens.map(escapeRegExp).join(`${NOT_TOKEN_CHAR}+`))
    // Longer alternatives first, so a word isn't cut short by a shorter one that also matches there.
    .sort((a, b) => b.length - a.length)
  return new RegExp(`(?<!${TOKEN_CHAR})(?:${alternatives.join('|')})${TOKEN_CHAR}*`, 'giu')
}

/** Joins matches with only punctuation or spaces between them into one, as `Retry-After` reads as one match. */
export function mergeMatches(parts: readonly TextPart[]): TextPart[] {
  const merged: TextPart[] = []
  for (const part of parts) {
    if (part.text === '') continue
    const last = merged.at(-1)
    const beforeLast = merged.at(-2)
    if (last?.match === true && part.match) {
      merged[merged.length - 1] = { text: last.text + part.text, match: true }
    } else if (
      part.match &&
      last?.match === false &&
      beforeLast?.match === true &&
      !/[\p{L}\p{N}\p{M}]/u.test(last.text)
    ) {
      merged.splice(-2, 2, { text: beforeLast.text + last.text + part.text, match: true })
    } else {
      merged.push(part)
    }
  }
  return merged
}

/** Splits `text` into the stretches `pattern` (from `highlightPattern`) matches and the text around them. */
export function highlightParts(text: string, pattern: RegExp | null): TextPart[] {
  if (pattern === null) return [{ text, match: false }]
  const parts: TextPart[] = []
  let at = 0
  for (const found of text.matchAll(pattern)) {
    parts.push({ text: text.slice(at, found.index), match: false })
    parts.push({ text: found[0], match: true })
    at = found.index + found[0].length
  }
  parts.push({ text: text.slice(at), match: false })
  return mergeMatches(parts)
}
