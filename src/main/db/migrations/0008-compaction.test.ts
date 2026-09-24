import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DividerKind, ToolCallState, ToolEventKind } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { compactionMigration } from './0008-compaction'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 8', () => {
  expect(MIGRATIONS[7]).toBe(compactionMigration)
})

it('keeps every tool log entry, and lets the log hold compactions', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 7))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text) VALUES ('n', 't', 1, 'narration', 1, 2, 'Looking.')`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_output, tool_state,
      tool_use_id, parent_tool_use_id)
    VALUES ('c', 't', 2, 'tool_call', 1, 3, 'Read', '{"file_path":"a.ts"}', 'x', 'done', 'toolu_1', NULL)`,
  ).run()
  db.prepare(
    "INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, divider_kind) VALUES ('d', 't', 3, 'divider', 2, 4, 'turn')",
  ).run()

  migrate(db, MIGRATIONS)

  expect(listToolEvents(db, 't').map((event) => event.kind)).toEqual([
    ToolEventKind.Narration,
    ToolEventKind.ToolCall,
    ToolEventKind.Divider,
  ])
  expect(listToolEvents(db, 't')[2]).toMatchObject({ dividerKind: DividerKind.Turn, turn: 2 })
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_state, compact_trigger, pre_tokens,
      post_tokens, window_tokens)
    VALUES ('k', 't', 4, 'compaction', 2, 5, 'done', 'manual', 198000, 41000, 200000)`,
  ).run()
  expect(listToolEvents(db, 't')[3]).toMatchObject({
    kind: ToolEventKind.Compaction,
    state: ToolCallState.Done,
    preTokens: 198_000,
    postTokens: 41_000,
  })
  // A compaction needs its trigger, and other entries can't carry compaction fields.
  expect(() =>
    db
      .prepare(
        "INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_state, window_tokens) VALUES ('x', 't', 5, 'compaction', 2, 6, 'done', 1)",
      )
      .run(),
  ).toThrow(/CHECK/)
  expect(() =>
    db
      .prepare(
        "INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text, pre_tokens) VALUES ('y', 't', 5, 'narration', 2, 6, 'Hi', 1)",
      )
      .run(),
  ).toThrow(/CHECK/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM tool_events').pluck().get()).toBe(0)
  db.close()
})
