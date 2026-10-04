import type { Database } from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getAgentTab, setAgentTab } from '../repositories/agent-tabs'
import { deleteTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { agentTabsMigration } from './0063-agent-tabs'

/** A database as it was before this migration, with a workspace and two tasks. */
function existingDatabase(): Database {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 63),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  const task = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES (?, 'w', 'Ship the rate-limit fixes', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1,
      NULL, NULL)`,
  )
  task.run('t')
  task.run('other')
  return db
}

it('is migration 63, after every earlier one', () => {
  expect(agentTabsMigration.version).toBe(63)
  expect(MIGRATIONS.indexOf(agentTabsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 63).length)
})

it('applies to an existing database, with every task on Main', () => {
  const db = existingDatabase()

  migrate(db, MIGRATIONS)

  expect(db.prepare('SELECT COUNT(*) FROM agent_tabs').pluck().get()).toBe(0)
  expect(getAgentTab(db, 't')).toBeNull()
  expect(db.prepare('SELECT id FROM tasks ORDER BY id').pluck().all()).toEqual(['other', 't'])
  db.close()
})

it('keeps one agent per task, never an empty one, and forgets it with its task', () => {
  const db = existingDatabase()
  migrate(db, MIGRATIONS)
  const insert = db.prepare('INSERT INTO agent_tabs (task_id, agent_id) VALUES (?, ?)')

  insert.run('t', 'toolu_fix_501')
  expect(() => insert.run('t', 'toolu_docs_503')).toThrow(/UNIQUE/)
  expect(() => insert.run('other', '')).toThrow(/CHECK/)
  expect(() => insert.run('gone', 'toolu_fix_501')).toThrow(/FOREIGN KEY/)

  setAgentTab(db, 'other', 'toolu_docs_503')
  expect(deleteTask(db, 't')).toBe(true)
  expect(db.prepare('SELECT task_id, agent_id FROM agent_tabs').all()).toEqual([
    { task_id: 'other', agent_id: 'toolu_docs_503' },
  ])
  db.close()
})
