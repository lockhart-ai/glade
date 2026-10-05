import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Row } from '../db/repositories/rows'

const entrySchema = z
  .object({ type: z.string(), uuid: z.string().optional(), timestamp: z.string().optional() })
  .catchall(z.unknown()) satisfies z.ZodType<SessionStoreEntry>

/** Opaque SDK entries retain tool results, thinking and child history. Append writes only the incoming delta. */
export function sqliteSessionStore(db: Database, taskId: string | null = null): SessionStore {
  const owner = taskId ?? ''
  const load = (key: SessionKey): SessionStoreEntry[] | null => {
    const rows = db
      .prepare(
        'SELECT entry FROM sdk_transcripts WHERE owner = ? AND project_key = ? AND session_id = ? AND subpath = ? ORDER BY ordinal',
      )
      .all(owner, key.projectKey, key.sessionId, key.subpath ?? '')
    return rows.length === 0
      ? null
      : rows.map((raw) => entrySchema.parse(new Row('sdk_transcripts', raw).json('entry')))
  }
  return {
    append(key, incoming) {
      db.transaction(() => {
        const scope = [owner, key.projectKey, key.sessionId, key.subpath ?? '']
        const ordinal = new Row(
          'sdk_transcripts',
          db
            .prepare(
              'SELECT coalesce(max(ordinal), -1) + 1 AS next FROM sdk_transcripts WHERE owner = ? AND project_key = ? AND session_id = ? AND subpath = ?',
            )
            .get(...scope),
        ).integer('next')
        const insert = db.prepare(`INSERT INTO sdk_transcripts VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner, project_key, session_id, subpath, entry_key) DO UPDATE SET entry = excluded.entry`)
        for (const [index, value] of incoming.entries()) {
          const entry = entrySchema.parse(value)
          insert.run(
            ...scope,
            entry.uuid === undefined ? `row:${randomUUID()}` : `uuid:${entry.uuid}`,
            JSON.stringify(entry),
            ordinal + index,
            taskId,
          )
        }
      })()
      return Promise.resolve()
    },
    load(key) {
      return Promise.resolve(load(key))
    },
    listSubkeys(key) {
      return Promise.resolve(
        db
          .prepare(
            "SELECT DISTINCT subpath FROM sdk_transcripts WHERE owner = ? AND project_key = ? AND session_id = ? AND subpath <> '' ORDER BY subpath",
          )
          .all(owner, key.projectKey, key.sessionId)
          .map((raw) => new Row('sdk_transcripts', raw).text('subpath')),
      )
    },
  }
}

export function hasTranscript(db: Database, sessionId: string, taskId: string | null = null): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sdk_transcripts WHERE owner = ? AND session_id = ? AND subpath = '' AND json_extract(entry, '$.type') IN ('user', 'assistant') AND NOT EXISTS (SELECT 1 FROM sdk_transcript_failures f WHERE f.owner = sdk_transcripts.owner AND f.session_id = sdk_transcripts.session_id AND f.reason = 'importing') LIMIT 1",
      )
      .get(taskId ?? '', sessionId) !== undefined
  )
}

/** Never resume a shorter mirror after the SDK reports a dropped append batch. Retained until the task is deleted. */
export function assertTranscriptHealthy(db: Database, sessionId: string, taskId: string | null): void {
  if (
    db
      .prepare("SELECT 1 FROM sdk_transcript_failures WHERE owner = ? AND session_id = ? AND reason = 'mirror_error'")
      .get(taskId ?? '', sessionId)
  )
    throw new Error('The saved SDK history is incomplete after a transcript storage failure. The task was not resumed.')
}

export function markTranscriptFailed(db: Database, sessionId: string, taskId: string | null): void {
  db.prepare("INSERT OR REPLACE INTO sdk_transcript_failures VALUES (?, ?, ?, 'mirror_error')").run(
    taskId ?? '',
    sessionId,
    taskId,
  )
}

/** An interrupted/partial import is never mistaken for a complete mirror. Claude keeps using its original files. */
export function beginTranscriptImport(db: Database, sessionId: string, taskId: string | null): void {
  db.transaction(() => {
    db.prepare('DELETE FROM sdk_transcripts WHERE owner = ? AND session_id = ?').run(taskId ?? '', sessionId)
    db.prepare("INSERT OR REPLACE INTO sdk_transcript_failures VALUES (?, ?, ?, 'importing')").run(
      taskId ?? '',
      sessionId,
      taskId,
    )
  })()
}

export function finishTranscriptImport(db: Database, sessionId: string, taskId: string | null): void {
  db.prepare("DELETE FROM sdk_transcript_failures WHERE owner = ? AND session_id = ? AND reason = 'importing'").run(
    taskId ?? '',
    sessionId,
  )
}
