import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ToolCallState, ToolEventKind } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { subagentLogMigration } from './0013-subagent-log'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 13', () => {
  expect(MIGRATIONS[12]).toBe(subagentLogMigration)
})

it('upgrades a v12 log, keeping every entry and state, and lets a note name its subagent and a call say when it finished', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 12))
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
    VALUES ('c', 't', 2, 'tool_call', 1, 3, 'Agent', '{"description":"API changes"}', 'Done.', 'done', 'toolu_1', NULL),
      ('p', 't', 4, 'tool_call', 1, 5, 'Bash', '{}', 'Paused.', 'paused', 'toolu_2', 'toolu_1'),
      ('i', 't', 5, 'tool_call', 1, 6, 'Read', '{}', NULL, 'interrupted', 'toolu_3', 'toolu_1')`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_state, compact_trigger, pre_tokens,
      post_tokens, window_tokens)
    VALUES ('k', 't', 3, 'compaction', 1, 4, 'done', 'manual', 198000, 41000, 200000)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listToolEvents(db, 't')).toMatchObject([
    { kind: ToolEventKind.Narration, text: 'Looking.', parentToolUseId: null },
    { kind: ToolEventKind.ToolCall, name: 'Agent', state: ToolCallState.Done, finishedAt: null },
    { kind: ToolEventKind.Compaction, preTokens: 198_000, postTokens: 41_000, windowTokens: 200_000 },
    // Migration 12's paused and interrupted states survive.
    { state: ToolCallState.Paused, output: 'Paused.', parentToolUseId: 'toolu_1', finishedAt: null },
    { state: ToolCallState.Interrupted, output: null, parentToolUseId: 'toolu_1', finishedAt: null },
  ])
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text, parent_tool_use_id)
    VALUES ('s', 't', 6, 'narration', 1, 7, 'Reading the PRs.', 'toolu_1')`,
  ).run()
  db.prepare("UPDATE tool_events SET finished_at = 9 WHERE id = 'c'").run()
  expect(listToolEvents(db, 't')).toMatchObject([
    {},
    { finishedAt: 9 },
    {},
    {},
    {},
    { kind: ToolEventKind.Narration, parentToolUseId: 'toolu_1' },
  ])
  db.prepare("UPDATE tool_events SET tool_state = 'paused' WHERE id = 'c'").run()
  // Only a tool call finishes, and a divider still has no parent.
  expect(() => db.prepare("UPDATE tool_events SET finished_at = 9 WHERE id = 's'").run()).toThrow(/CHECK/)
  expect(() =>
    db
      .prepare(
        "INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, divider_kind, parent_tool_use_id) VALUES ('d', 't', 8, 'divider', 1, 8, 'turn', 'toolu_1')",
      )
      .run(),
  ).toThrow(/CHECK/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM tool_events').pluck().get()).toBe(0)
  db.close()
})
