import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getSessionContext, setSessionContext } from '../repositories/session-context'
import { MIGRATIONS } from '.'
import { sessionSandboxContextMigration } from './0058-session-sandbox-context'

it('is migration 58, after every earlier one', () => {
  expect(sessionSandboxContextMigration.version).toBe(58)
  expect(MIGRATIONS.indexOf(sessionSandboxContextMigration)).toBe(MIGRATIONS.filter((m) => m.version < 58).length)
})

it('leaves every session recorded before it as not told of the sandbox, and keeps what it is told from then on', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 58),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  for (const id of ['glade', 'imported']) {
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
        created_at, updated_at, done_at, session_id)
      VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, ?)`,
    ).run(id, `session-${id}`)
  }
  db.prepare(
    "INSERT INTO session_context (task_id, instructions, instruction_updates, handoff_at) VALUES ('glade', 1, 2, 3)",
  ).run()
  db.prepare(
    "INSERT INTO session_context (task_id, instructions, instruction_updates, handoff_at) VALUES ('imported', 0, 0, NULL)",
  ).run()

  migrate(db, MIGRATIONS)

  // What was recorded stays as it was; neither was told of the sandbox.
  expect(getSessionContext(db, 'glade')).toEqual({
    instructions: true,
    instructionUpdates: 2,
    handoffAt: 3,
    sandbox: false,
  })
  expect(getSessionContext(db, 'imported')).toEqual({
    instructions: false,
    instructionUpdates: 0,
    handoffAt: null,
    sandbox: false,
  })

  setSessionContext(db, 'glade', { instructions: true, instructionUpdates: 2, handoffAt: 3, sandbox: true })
  expect(getSessionContext(db, 'glade')?.sandbox).toBe(true)
  expect(getSessionContext(db, 'imported')?.sandbox).toBe(false)
  // Told is told: recording it again as not told is a caller's mistake the column still takes, but only 0 or 1.
  setSessionContext(db, 'glade', { instructions: true, instructionUpdates: 2, handoffAt: 3, sandbox: false })
  expect(getSessionContext(db, 'glade')?.sandbox).toBe(false)
  expect(() => db.prepare("UPDATE session_context SET sandbox = 2 WHERE task_id = 'glade'").run()).toThrow(/CHECK/)
  db.close()
})
