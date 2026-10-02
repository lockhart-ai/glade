import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { findSubagentCall } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { subagentTaskIdsMigration } from './0047-subagent-task-ids'

it('is migration 47, after every earlier one', () => {
  expect(subagentTaskIdsMigration.version).toBe(47)
  expect(MIGRATIONS.indexOf(subagentTaskIdsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 47).length)
})

it('leaves every logged call without an SDK task id, and lets only a tool call have one', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 47),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_state, tool_use_id)
    VALUES ('c', 't', 1, 'tool_call', 1, 2, 'Agent', '{"description":"API changes"}', 'done', 'toolu_1')`,
  ).run()
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text) VALUES ('n', 't', 2, 'narration', 1, 3, 'Looking.')`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(db.prepare("SELECT sdk_task_id FROM tool_events WHERE id = 'c'").get()).toEqual({ sdk_task_id: null })
  expect(findSubagentCall(db, 't', 'a1b2')).toBeUndefined()
  db.prepare("UPDATE tool_events SET sdk_task_id = 'a1b2' WHERE id = 'c'").run()
  expect(findSubagentCall(db, 't', 'a1b2')).toMatchObject({ toolUseId: 'toolu_1', name: 'Agent' })
  expect(() => db.prepare("UPDATE tool_events SET sdk_task_id = 'a1b2' WHERE id = 'n'").run()).toThrow(/CHECK/)
  db.close()
})
