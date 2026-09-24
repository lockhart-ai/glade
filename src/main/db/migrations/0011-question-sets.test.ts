import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listQuestionSets } from '../repositories/question-sets'
import { getTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { questionSetsMigration } from './0011-question-sets'

it('is migration 11', () => {
  expect(MIGRATIONS[10]).toBe(questionSetsMigration)
})

it('starts every existing task with no questions, dropped with its task, and checks the JSON columns', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 10))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listQuestionSets(db, 't')).toEqual([])
  expect(getTask(db, 't')?.asking).toBe(false)
  const insert = db.prepare("INSERT INTO question_sets VALUES ('q', 't', 1, ?, 'open', ?, 2, NULL)")
  expect(() => insert.run('{}', null)).toThrow(/CHECK/)
  expect(() => insert.run('[]', '[]')).toThrow(/CHECK/)
  insert.run('[]', null)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM question_sets').pluck().get()).toBe(0)
  db.close()
})
