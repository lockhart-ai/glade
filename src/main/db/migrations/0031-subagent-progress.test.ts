import { expect, it } from 'vitest'
import { ToolCallState } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { subagentProgressMigration } from './0031-subagent-progress'

it('is migration 31', () => {
  expect(MIGRATIONS[30]).toBe(subagentProgressMigration)
})

it('starts every logged call with no summary, and lets only a tool call have one', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 30))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_state, tool_use_id)
    VALUES ('c', 't', 1, 'tool_call', 1, 2, 'Agent', '{"description":"API changes"}', 'running', 'toolu_1')`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text) VALUES ('n', 't', 2, 'narration', 1, 3, 'Looking.')`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listToolEvents(db, 't')).toMatchObject([
    { name: 'Agent', state: ToolCallState.Running, progressSummary: null },
    { text: 'Looking.' },
  ])
  db.prepare("UPDATE tool_events SET progress_summary = 'Reading the API PRs' WHERE id = 'c'").run()
  expect(listToolEvents(db, 't')).toMatchObject([{ progressSummary: 'Reading the API PRs' }, {}])
  expect(() => db.prepare("UPDATE tool_events SET progress_summary = 'Reading' WHERE id = 'n'").run()).toThrow(/CHECK/)
  db.close()
})
