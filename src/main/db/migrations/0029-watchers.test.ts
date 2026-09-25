import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listWatchers } from '../repositories/watchers'
import { MIGRATIONS } from '.'
import { watchersMigration } from './0029-watchers'

it('is migration 29', () => {
  expect(MIGRATIONS[28]).toBe(watchersMigration)
})

it('starts every existing task with no watchers, keeps one per tool call, checks its values, and drops them with their task', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 28))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listWatchers(db, 't')).toEqual([])
  const insert = (id: string, kind: string, state: string) =>
    db
      .prepare(
        `INSERT INTO watchers (id, task_id, kind, tool_use_id, label, detail, recurring, state, started_at)
        VALUES (?, 't', ?, 'toolu_1', 'CI', 'gh pr checks 42', 1, ?, 1)`,
      )
      .run(id, kind, state)
  insert('a', 'monitor', 'running')
  expect(listWatchers(db, 't')).toMatchObject([{ wakes: 0, stoppedByYou: false, recurring: true }])
  expect(() => insert('b', 'monitor', 'running')).toThrow(/UNIQUE/)
  db.prepare("DELETE FROM watchers WHERE id = 'a'").run()
  expect(() => insert('c', 'hook', 'running')).toThrow(/CHECK/)
  expect(() => insert('d', 'cron', 'paused')).toThrow(/CHECK/)
  insert('e', 'cron', 'suspended')
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM watchers').pluck().get()).toBe(0)
  db.close()
})
