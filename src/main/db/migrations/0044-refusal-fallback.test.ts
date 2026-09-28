import { expect, it } from 'vitest'
import { RefusalScope, ToolCallState } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { appendRefusalFallback, listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { refusalFallbackMigration } from './0044-refusal-fallback'

it('is migration 44', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 44)).toBe(refusalFallbackMigration)
})

it('keeps every existing kind of tool log entry across the rebuild, and adds the refusal-fallback kind', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 44),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text) VALUES ('n', 't', 1, 'narration', 1, 1, 'Looking.')`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_output,
      tool_state, tool_use_id)
    VALUES ('c', 't', 2, 'tool_call', 1, 2, 'Bash', '{}', 'ok', 'done', 'toolu_1')`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, divider_kind)
    VALUES ('d', 't', 3, 'divider', 2, 3, 'turn')`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_state, compact_trigger, pre_tokens,
      post_tokens, window_tokens)
    VALUES ('k', 't', 4, 'compaction', 2, 4, 'done', 'auto', 198000, 41000, 200000)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listToolEvents(db, 't')).toMatchObject([
    { text: 'Looking.' },
    { name: 'Bash', state: ToolCallState.Done },
    { dividerKind: 'turn' },
    { preTokens: 198_000 },
  ])

  const notice = appendRefusalFallback(db, {
    taskId: 't',
    turn: 2,
    originalModel: 'claude-opus-5-5',
    fallbackModel: 'claude-sonnet-5',
    category: 'cyber',
    scope: RefusalScope.Session,
  })
  expect(listToolEvents(db, 't')).toMatchObject([{}, {}, {}, {}, { ...notice }])

  // A category can be null (the SDK didn't say), but the models and scope can't.
  expect(() =>
    db
      .prepare(
        `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, refusal_original_model, refusal_scope)
        VALUES ('bad', 't', 6, 'refusal_fallback', 2, 5, 'claude-opus-5-5', 'session')`,
      )
      .run(),
  ).toThrow(/CHECK/)
  // No other kind may carry a refusal field.
  expect(() =>
    db
      .prepare(
        `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text, refusal_category)
        VALUES ('bad2', 't', 6, 'narration', 2, 5, 'Looking.', 'cyber')`,
      )
      .run(),
  ).toThrow(/CHECK/)
  db.close()
})
