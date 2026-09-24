import type { Database } from 'better-sqlite3'
import { ftsQuery, mergeMatches, SearchField, type SearchResult, type TextPart } from '../../../shared/search'
import { Row } from './rows'

/**
 * What `snippet()` wraps each match in: control characters, which chat text doesn't carry, so they can't be confused
 * with it. The snippet is split on them into parts; nothing is ever turned into markup.
 */
const OPEN = '\u0002'
const CLOSE = '\u0003'
const ELLIPSIS = '…'
/** Roughly how many words a snippet shows around its match: enough that it rarely cuts a phrase match short. */
const SNIPPET_TOKENS = 14

/**
 * How a match in each field ranks its task, best first: a word in the title says more about the task than one in its
 * objective or status, and those more than one somewhere in its chat. (Not FTS5's bm25 rank: working that out for
 * every match of a one-letter prefix, which matches most of a big workspace, is too slow to keep up with typing.)
 */
const FIELD_PRIORITY: Readonly<Record<SearchField, number>> = {
  [SearchField.Title]: 0,
  [SearchField.Objective]: 1,
  [SearchField.Status]: 1,
  [SearchField.Message]: 2,
}

const FIELDS = Object.values(SearchField)

/** A `CASE` giving each field its number in `numbers`, for the `field` column in scope. */
function fieldCase(numbers: Readonly<Record<SearchField, number>>): string {
  return `CASE field ${FIELDS.map((field) => `WHEN '${field}' THEN ${String(numbers[field])}`).join(' ')} END`
}

/**
 * How good a snippet each field makes, best highest: anything beats the title, which the result's row shows anyway,
 * the objective (what the task is for) beats the status, and either beats a message.
 */
const SNIPPET_ORDER: Readonly<Record<SearchField, number>> = {
  [SearchField.Title]: 0,
  [SearchField.Message]: 1,
  [SearchField.Objective]: 3,
  [SearchField.Status]: 2,
}

/** More than any document id, so a snippet key holds the field's order above the id. */
const ID_SPAN = 1_000_000_000_000

/**
 * Every matching task, best first, each with the document its snippet comes from. All in SQL, so however many fields
 * and messages match (a one-letter prefix matches most of a big workspace), only a row per task comes back. Each task
 * gets its best match's `FIELD_PRIORITY`, and its snippet key (`SNIPPET_ORDER` × `ID_SPAN` + id) picks its best
 * snippet, the latest of those as good.
 */
const RANKED_SQL = `
  WITH matches AS (
    SELECT search_documents.task_id, search_documents.id, search_documents.field
    FROM search_fts
    JOIN search_documents ON search_documents.id = search_fts.rowid
    WHERE search_fts MATCH ? AND search_documents.workspace_id = ?
  ),
  matched_tasks AS (
    SELECT task_id, MIN(${fieldCase(FIELD_PRIORITY)}) AS priority,
      MAX(${fieldCase(SNIPPET_ORDER)} * ${String(ID_SPAN)} + id) AS snippet_key
    FROM matches
    GROUP BY task_id
  )
  SELECT search_documents.id, search_documents.task_id, search_documents.field
  FROM matched_tasks
  JOIN search_documents ON search_documents.id = matched_tasks.snippet_key % ${String(ID_SPAN)}
  JOIN tasks ON tasks.id = matched_tasks.task_id
  ORDER BY matched_tasks.priority, tasks.updated_at DESC`

/** A matching task, and the document its snippet comes from. */
interface Ranked {
  readonly documentId: number
  readonly taskId: string
  readonly field: SearchField
}

function parseRanked(raw: unknown): Ranked {
  const row = new Row('search_documents', raw)
  return { documentId: row.integer('id'), taskId: row.text('task_id'), field: row.oneOf('field', FIELDS) }
}

/** A snippet from `snippet()`, split at its markers into the matches and the text around them. */
export function parseSnippet(snippet: string): TextPart[] {
  const parts: TextPart[] = []
  let match = false
  let text = ''
  for (const char of snippet) {
    if (char === OPEN || char === CLOSE) {
      parts.push({ text, match })
      match = char === OPEN
      text = ''
    } else {
      text += char
    }
  }
  parts.push({ text, match })
  return mergeMatches(parts)
}

/**
 * The snippet of each document, by id. The unary `+` keeps the rowid list from being handed to FTS5, which would run
 * the query again for each id; instead one pass over the matches makes snippets for just these.
 */
function snippets(db: Database, query: string, documentIds: readonly number[]): Map<number, TextPart[]> {
  const rows = db
    .prepare(
      `SELECT rowid AS id, snippet(search_fts, 0, ?, ?, ?, ?) AS snippet FROM search_fts
      WHERE search_fts MATCH ? AND +rowid IN (SELECT value FROM json_each(?))`,
    )
    .all(OPEN, CLOSE, ELLIPSIS, SNIPPET_TOKENS, query, JSON.stringify(documentIds))
  return new Map(
    rows.map((raw) => {
      const row = new Row('search_fts', raw)
      return [row.integer('id'), parseSnippet(row.text('snippet'))]
    }),
  )
}

/**
 * Searches a workspace's tasks for `text` (plain text, never FTS5 syntax: see `ftsQuery`): one result per matching
 * task, best first. A task ranks by the field of its best match (`FIELD_PRIORITY`), ties going to the most recently
 * updated. Its snippet is from its best match outside the title (the latest message, among messages), or from the
 * title when that's all that matches.
 */
export function searchTasks(db: Database, workspaceId: string, text: string): SearchResult[] {
  const query = ftsQuery(text)
  if (query === null) return []
  const ranked = db.prepare(RANKED_SQL).all(query, workspaceId).map(parseRanked)
  const snippetOf = snippets(
    db,
    query,
    ranked.map(({ documentId }) => documentId),
  )
  return ranked.map(({ documentId, taskId, field }) => ({
    taskId,
    field,
    snippet: snippetOf.get(documentId) ?? [],
  }))
}
