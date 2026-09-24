import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { ftsQuery, mergeMatches, SearchField, type SearchResult, type TextPart } from '../../../shared/search'
import { Row } from './rows'

/**
 * What `snippet()` wraps each match in: control characters, which chat text doesn't carry, so they can't be confused
 * with it. The snippet is split on them into parts; nothing is ever turned into markup.
 */
const OPEN = '\u0002'
const CLOSE = '\u0003'
const ELLIPSIS = '…'
/** Roughly how many words a snippet shows around its match. */
const SNIPPET_TOKENS = 10

/**
 * How much a match in each field counts for, multiplying FTS5's bm25 rank: a word in the title says more about the
 * task than the same word somewhere in its chat.
 */
const FIELD_WEIGHT: Readonly<Record<SearchField, number>> = {
  [SearchField.Title]: 3,
  [SearchField.Objective]: 2,
  [SearchField.Status]: 2,
  [SearchField.Message]: 1,
}

/** One field or message that matches. */
interface Hit {
  readonly documentId: number
  readonly taskId: string
  readonly field: SearchField
  /** FTS5's bm25 rank times the field's weight: lower is better. */
  readonly score: number
}

/** A matching task: its best match's score, and the match its snippet comes from. */
interface TaskHit {
  readonly score: number
  readonly updatedAt: number
  readonly snippetHit: Hit
}

/**
 * Every field and message of the workspace's that matches, with its task's `updated_at`. Read as an array per row:
 * a one-letter prefix matches most of them, and this is the one query that returns that many.
 */
const HITS_SQL = `
  SELECT search_documents.id, search_documents.task_id, search_documents.field, search_fts.rank, tasks.updated_at
  FROM search_fts
  JOIN search_documents ON search_documents.id = search_fts.rowid
  JOIN tasks ON tasks.id = search_documents.task_id
  WHERE search_fts MATCH ? AND search_documents.workspace_id = ?`

const hitRow = z.tuple([z.int(), z.string(), z.enum(SearchField), z.number(), z.int()])

/** Whether `hit` makes a better snippet than `current`: anything beats the title, which the row shows anyway. */
function betterSnippet(hit: Hit, current: Hit): boolean {
  const titles = Number(hit.field === SearchField.Title) - Number(current.field === SearchField.Title)
  return titles === 0 ? hit.score < current.score : titles < 0
}

/** The matching tasks, by task id. */
function groupByTask(rows: readonly unknown[]): Map<string, TaskHit> {
  const tasks = new Map<string, TaskHit>()
  for (const raw of rows) {
    const [documentId, taskId, field, rank, updatedAt] = hitRow.parse(raw)
    const hit: Hit = { documentId, taskId, field, score: rank * FIELD_WEIGHT[field] }
    const current = tasks.get(taskId)
    if (current === undefined) {
      tasks.set(taskId, { score: hit.score, updatedAt, snippetHit: hit })
    } else {
      tasks.set(taskId, {
        score: Math.min(current.score, hit.score),
        updatedAt,
        snippetHit: betterSnippet(hit, current.snippetHit) ? hit : current.snippetHit,
      })
    }
  }
  return tasks
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
 * task, best first. A task ranks by its best match, weighted by field (`FIELD_WEIGHT`), ties going to the most
 * recently updated. Its snippet is from its best match outside the title, or from the title when that's all that
 * matches.
 */
export function searchTasks(db: Database, workspaceId: string, text: string): SearchResult[] {
  const query = ftsQuery(text)
  if (query === null) return []
  const hits = db.prepare(HITS_SQL).raw().all(query, workspaceId)
  const ranked = [...groupByTask(hits).values()].sort((a, b) => a.score - b.score || b.updatedAt - a.updatedAt)
  const snippetOf = snippets(
    db,
    query,
    ranked.map(({ snippetHit }) => snippetHit.documentId),
  )
  return ranked.map(({ snippetHit: { documentId, taskId, field } }) => ({
    taskId,
    field,
    snippet: snippetOf.get(documentId) ?? [],
  }))
}
