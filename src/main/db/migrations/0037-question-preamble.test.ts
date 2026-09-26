import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listQuestionSets } from '../repositories/question-sets'
import { MIGRATIONS } from '.'
import { questionPreambleMigration } from './0037-question-preamble'

it('is migration 37', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 37)).toBe(questionPreambleMigration)
})

it('keeps every question set asked before it, with no preamble, and refuses an empty one', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 37),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  const questions = JSON.stringify([{ kind: 'text', prompt: 'Which branch?' }])
  db.prepare(
    `INSERT INTO question_sets (id, task_id, turn, questions, state, reply, created_at, closed_at)
    VALUES ('old', 't', 1, ?, 'answered', '{"kind":"free_text","text":"main"}', 2, 3)`,
  ).run(questions)

  migrate(db, MIGRATIONS)

  expect(listQuestionSets(db, 't')).toEqual([
    {
      id: 'old',
      taskId: 't',
      turn: 1,
      preamble: null,
      questions: [{ kind: 'text', prompt: 'Which branch?' }],
      state: 'answered',
      reply: { kind: 'free_text', text: 'main' },
      createdAt: 2,
      closedAt: 3,
    },
  ])
  const insert = (id: string, preamble: string | null) =>
    db
      .prepare(
        `INSERT INTO question_sets (id, task_id, turn, preamble, questions, state, created_at)
        VALUES (?, 't', 2, ?, ?, 'open', 4)`,
      )
      .run(id, preamble, questions)
  insert('with', 'The tests pass on `main`.')
  expect(() => insert('empty', '')).toThrow(/CHECK/)
  expect(listQuestionSets(db, 't').map(({ preamble }) => preamble)).toEqual([null, 'The tests pass on `main`.'])
  db.close()
})
