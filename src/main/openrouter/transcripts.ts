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
      return Promise.resolve().then(() => {
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
      })
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

export function hasTranscript(
  db: Database,
  sessionId: string,
  taskId: string | null = null,
  importing = false,
): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sdk_transcripts WHERE owner = ? AND session_id = ? AND subpath = '' AND json_extract(entry, '$.type') IN ('user', 'assistant') AND (? OR NOT EXISTS (SELECT 1 FROM sdk_transcript_failures f WHERE f.owner = sdk_transcripts.owner AND f.session_id = sdk_transcripts.session_id AND f.reason = 'importing')) LIMIT 1",
      )
      .get(taskId ?? '', sessionId, importing ? 1 : 0) !== undefined
  )
}

/** Recovery's source survives a crash during import as well as the original mirror failure. */
export function failedTranscriptConfig(db: Database, sessionId: string, taskId: string | null): string | null {
  const raw = db
    .prepare(
      'SELECT config_dir FROM sdk_transcript_failures WHERE owner = ? AND session_id = ? AND config_dir IS NOT NULL',
    )
    .get(taskId ?? '', sessionId)
  return raw === undefined ? null : new Row('sdk_transcript_failures', raw).text('config_dir')
}

export function markTranscriptFailed(db: Database, sessionId: string, taskId: string | null, configDir: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO sdk_transcript_failures (owner, session_id, task_id, reason, config_dir) VALUES (?, ?, ?, 'mirror_error', ?)",
  ).run(taskId ?? '', sessionId, taskId, configDir)
}

/** An interrupted/partial import is never mistaken for a complete mirror. Claude keeps using its original files. */
export function beginTranscriptImport(
  db: Database,
  sessionId: string,
  taskId: string | null,
  configDir: string | null = null,
): void {
  db.transaction(() => {
    if (configDir !== null)
      db.prepare(
        `INSERT OR IGNORE INTO sdk_transcript_backups (owner, session_id, task_id, entries)
      SELECT ?, ?, ?, json_group_array(json_object('project', project_key, 'subpath', subpath, 'key', entry_key, 'entry', entry, 'ordinal', ordinal))
      FROM sdk_transcripts WHERE owner = ? AND session_id = ?`,
      ).run(taskId ?? '', sessionId, taskId, taskId ?? '', sessionId)
    db.prepare('DELETE FROM sdk_transcripts WHERE owner = ? AND session_id = ?').run(taskId ?? '', sessionId)
    db.prepare(
      "INSERT OR REPLACE INTO sdk_transcript_failures (owner, session_id, task_id, reason, config_dir) VALUES (?, ?, ?, 'importing', ?)",
    ).run(taskId ?? '', sessionId, taskId, configDir)
  })()
}

export function finishTranscriptImport(db: Database, sessionId: string, taskId: string | null): void {
  db.transaction(() => {
    db.prepare("DELETE FROM sdk_transcript_failures WHERE owner = ? AND session_id = ? AND reason = 'importing'").run(
      taskId ?? '',
      sessionId,
    )
    db.prepare('DELETE FROM sdk_transcript_backups WHERE owner = ? AND session_id = ?').run(taskId ?? '', sessionId)
  })()
}

/** Roll back a partial rebuild too: retain the previous mirror for recovery, without calling it complete. */
export function discardTranscriptImport(db: Database, sessionId: string, taskId: string | null): void {
  db.transaction(() => {
    db.prepare('DELETE FROM sdk_transcripts WHERE owner = ? AND session_id = ?').run(taskId ?? '', sessionId)
    db.prepare(
      `INSERT INTO sdk_transcripts
      SELECT b.owner, json_extract(j.value, '$.project'), b.session_id, json_extract(j.value, '$.subpath'),
        json_extract(j.value, '$.key'), json_extract(j.value, '$.entry'), json_extract(j.value, '$.ordinal'), b.task_id
      FROM sdk_transcript_backups b, json_each(b.entries) j WHERE b.owner = ? AND b.session_id = ?`,
    ).run(taskId ?? '', sessionId)
    finishTranscriptImport(db, sessionId, taskId)
  })()
}
