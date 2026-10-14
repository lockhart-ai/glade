import type { Database } from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { questionCardDraftsMigration } from './0076-question-card-drafts'

const QUESTIONS = JSON.stringify([
  { kind: 'pills', prompt: 'Where does the upgrade go?', options: ['Features', 'Leave it out'] },
])

function openQuestionSet(db: Database, id: string): void {
  db.prepare(
    "INSERT INTO question_sets (id, task_id, turn, questions, state, created_at) VALUES (?, 't1', 1, ?, 'open', 1)",
  ).run(id, QUESTIONS)
}

it('is migration 76', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 76)).toBe(questionCardDraftsMigration)
})

it('adds the question sets a nullable draft column, and leaves every set without one', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 76),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      "VALUES ('t1', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)",
  ).run()
  openQuestionSet(db, 'q1')

  migrate(db, MIGRATIONS)

  expect(db.prepare('SELECT draft FROM question_sets WHERE id = ?').pluck().get('q1')).toBeNull()
  db.close()
})

it('keeps a JSON object as the draft, and refuses anything else', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      "VALUES ('t1', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)",
  ).run()
  openQuestionSet(db, 'q1')
  openQuestionSet(db, 'q2')

  db.prepare('UPDATE question_sets SET draft = ? WHERE id = ?').run(
    '{"draft":{"0":"Features"},"anythingElse":""}',
    'q1',
  )
  expect(() => db.prepare('UPDATE question_sets SET draft = ? WHERE id = ?').run('"Features"', 'q2')).toThrow()

  expect(db.prepare('SELECT draft FROM question_sets WHERE id = ?').pluck().get('q1')).toBe(
    '{"draft":{"0":"Features"},"anythingElse":""}',
  )
  db.close()
})
