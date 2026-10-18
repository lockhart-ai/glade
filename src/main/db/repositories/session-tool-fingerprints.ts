/**
 * Which of Glade's own tools a task's session has last been told about, and what each one's fingerprint
 * (`../../agent/tool-fingerprint`) was then (`session_tool_fingerprints`, #709): so a session is told, once, when
 * one it already knew has changed since.
 */
import type { Database } from 'better-sqlite3'
import { Row } from './rows'

/** Every tool fingerprint recorded for the task's session, by tool name; empty when none is. */
export function getToolFingerprints(db: Database, taskId: string): ReadonlyMap<string, string> {
  const rows: unknown[] = db
    .prepare('SELECT tool_name, hash FROM session_tool_fingerprints WHERE task_id = ?')
    .all(taskId)
  return new Map(
    rows.map((raw) => {
      const row = new Row('session_tool_fingerprints', raw)
      return [row.text('tool_name'), row.text('hash')] as const
    }),
  )
}

/** Records `fingerprints` as what the task's session has now been told of each tool, by name. */
export function setToolFingerprints(db: Database, taskId: string, fingerprints: ReadonlyMap<string, string>): void {
  const upsert = db.prepare(
    `INSERT INTO session_tool_fingerprints (task_id, tool_name, hash) VALUES (@taskId, @toolName, @hash)
    ON CONFLICT (task_id, tool_name) DO UPDATE SET hash = excluded.hash`,
  )
  const run = db.transaction((entries: readonly (readonly [string, string])[]) => {
    for (const [toolName, hash] of entries) upsert.run({ taskId, toolName, hash })
  })
  run([...fingerprints.entries()])
}
