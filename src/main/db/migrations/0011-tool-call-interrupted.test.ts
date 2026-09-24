import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CompactionTrigger, DividerKind, ToolCallState, ToolEventKind } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { toolCallInterruptedMigration } from './0011-tool-call-interrupted'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 11', () => {
  expect(MIGRATIONS[10]).toBe(toolCallInterruptedMigration)
})

it('keeps every tool log entry, and lets a tool call be paused or interrupted', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 10))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  const insert = (sql: string): void => {
    db.prepare(sql).run()
  }
  insert(
    "INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text) VALUES ('n', 't', 1, 'narration', 1, 2, 'Looking.')",
  )
  insert(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_output, tool_state,
      tool_use_id, parent_tool_use_id)
    VALUES ('c', 't', 2, 'tool_call', 1, 3, 'Read', '{"file_path":"a.ts"}', 'x', 'error', 'toolu_1', NULL)`,
  )
  insert(
    "INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, divider_kind) VALUES ('d', 't', 3, 'divider', 2, 4, 'turn')",
  )
  insert(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_state, compact_trigger, pre_tokens,
      post_tokens, window_tokens)
    VALUES ('k', 't', 4, 'compaction', 2, 5, 'done', 'auto', 198000, 41000, 200000)`,
  )

  migrate(db, MIGRATIONS)

  const events = listToolEvents(db, 't')
  expect(events.map((event) => event.kind)).toEqual([
    ToolEventKind.Narration,
    ToolEventKind.ToolCall,
    ToolEventKind.Divider,
    ToolEventKind.Compaction,
  ])
  expect(events[1]).toMatchObject({ state: ToolCallState.Error, output: 'x', toolUseId: 'toolu_1' })
  expect(events[2]).toMatchObject({ dividerKind: DividerKind.Turn, turn: 2 })
  expect(events[3]).toMatchObject({
    trigger: CompactionTrigger.Auto,
    preTokens: 198000,
    postTokens: 41000,
    windowTokens: 200000,
  })

  for (const [seq, state] of [
    [5, ToolCallState.Paused],
    [6, ToolCallState.Interrupted],
  ] as const) {
    insert(
      `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_state, tool_use_id)
      VALUES ('${state}', 't', ${String(seq)}, 'tool_call', 2, 6, 'Bash', '{}', '${state}', 'toolu_${state}')`,
    )
  }
  expect(listToolEvents(db, 't').slice(4)).toMatchObject([
    { state: ToolCallState.Paused },
    { state: ToolCallState.Interrupted },
  ])
  expect(() => {
    insert(
      `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_state, tool_use_id)
      VALUES ('bad', 't', 7, 'tool_call', 2, 7, 'Bash', '{}', 'stopped', 'toolu_bad')`,
    )
  }).toThrow(/CHECK constraint failed/)
  db.close()
})
