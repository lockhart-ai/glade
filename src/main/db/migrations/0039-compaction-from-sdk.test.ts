import { expect, it } from 'vitest'
import { AutoCompactKind } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getTask } from '../repositories/tasks'
import { listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { compactionFromSdkMigration } from './0039-compaction-from-sdk'

it('is migration 39', () => {
  expect(MIGRATIONS[38]).toBe(compactionFromSdkMigration)
})

it('starts every task with no word from the SDK and every compaction with no summary, and holds each to its kind', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 38))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_state, compact_trigger, pre_tokens,
      post_tokens, window_tokens)
    VALUES ('k', 't', 1, 'compaction', 1, 2, 'done', 'auto', 198000, 41000, 200000)`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text) VALUES ('n', 't', 2, 'narration', 1, 3, 'Looking.')`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(getTask(db, 't')?.autoCompact).toBeNull()
  expect(listToolEvents(db, 't')).toMatchObject([{ preTokens: 198_000, summary: null }, { text: 'Looking.' }])
  db.prepare(`UPDATE tasks SET auto_compact = '{"kind":"off"}' WHERE id = 't'`).run()
  expect(getTask(db, 't')?.autoCompact).toEqual({ kind: AutoCompactKind.Off })
  expect(() => db.prepare("UPDATE tasks SET auto_compact = 'off' WHERE id = 't'").run()).toThrow(/CHECK/)
  db.prepare("UPDATE tool_events SET compact_summary = 'Carried on.' WHERE id = 'k'").run()
  expect(listToolEvents(db, 't')).toMatchObject([{ summary: 'Carried on.' }, {}])
  expect(() => db.prepare("UPDATE tool_events SET compact_summary = 'x' WHERE id = 'n'").run()).toThrow(/CHECK/)
  db.close()
})
