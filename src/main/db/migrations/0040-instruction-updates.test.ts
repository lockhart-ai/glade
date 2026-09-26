import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getSessionContext, setSessionContext } from '../repositories/session-context'
import { MIGRATIONS } from '.'
import { instructionUpdatesMigration } from './0040-instruction-updates'

it('is migration 40', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 40)).toBe(instructionUpdatesMigration)
})

it('leaves every session recorded before it with none of the instructions added since, and refuses a negative count', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 40),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  for (const id of ['glade', 'imported']) {
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
        created_at, updated_at, done_at, session_id)
      VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, ?)`,
    ).run(id, `session-${id}`)
  }
  db.prepare("INSERT INTO session_context (task_id, instructions, handoff_at) VALUES ('glade', 1, 2)").run()
  db.prepare("INSERT INTO session_context (task_id, instructions, handoff_at) VALUES ('imported', 0, NULL)").run()

  migrate(db, MIGRATIONS)

  expect(getSessionContext(db, 'glade')).toEqual({ instructions: true, instructionUpdates: 0, handoffAt: 2 })
  expect(getSessionContext(db, 'imported')).toEqual({ instructions: false, instructionUpdates: 0, handoffAt: null })
  setSessionContext(db, 'glade', { instructions: true, instructionUpdates: 1, handoffAt: 2 })
  expect(getSessionContext(db, 'glade')).toEqual({ instructions: true, instructionUpdates: 1, handoffAt: 2 })
  expect(() => db.prepare("UPDATE session_context SET instruction_updates = -1 WHERE task_id = 'glade'").run()).toThrow(
    /CHECK/,
  )
  db.close()
})
