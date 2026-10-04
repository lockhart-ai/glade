import { expect, it } from 'vitest'
import { ChildKind } from '../../../shared/todoHub'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listOwedFilings, oweFilings } from '../repositories/owed-filings'
import { getSessionContext, setSessionContext } from '../repositories/session-context'
import { MIGRATIONS } from '.'
import { fileAtCreationMigration } from './0061-file-at-creation'

it('is migration 61, after every earlier one', () => {
  expect(fileAtCreationMigration.version).toBe(61)
  expect(MIGRATIONS.indexOf(fileAtCreationMigration)).toBe(MIGRATIONS.filter((m) => m.version < 61).length)
})

it('leaves every session recorded before it as not told of the todo hub, and nothing owed', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 61),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  for (const id of ['glade', 'imported']) {
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
        created_at, updated_at, done_at, session_id)
      VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, ?)`,
    ).run(id, `session-${id}`)
  }
  const record = db.prepare(
    'INSERT INTO session_context (task_id, instructions, instruction_updates, handoff_at, sandbox) VALUES (?, ?, ?, ?, ?)',
  )
  record.run('glade', 1, 2, 3, 1)
  record.run('imported', 0, 0, null, 0)

  migrate(db, MIGRATIONS)

  // What was recorded stays as it was, the count of instructions it was sent included; neither was told of the hub.
  expect(getSessionContext(db, 'glade')).toEqual({
    instructions: true,
    instructionUpdates: 2,
    handoffAt: 3,
    sandbox: true,
    todoHub: false,
  })
  expect(getSessionContext(db, 'imported')).toEqual({
    instructions: false,
    instructionUpdates: 0,
    handoffAt: null,
    sandbox: false,
    todoHub: false,
  })
  expect(listOwedFilings(db, 'glade')).toEqual([])

  // Told is kept, apart from everything else recorded.
  setSessionContext(db, 'glade', {
    instructions: true,
    instructionUpdates: 2,
    handoffAt: 3,
    sandbox: true,
    todoHub: true,
  })
  expect(getSessionContext(db, 'glade')).toMatchObject({ instructionUpdates: 2, sandbox: true, todoHub: true })
  expect(getSessionContext(db, 'imported')?.todoHub).toBe(false)
  expect(() => db.prepare("UPDATE session_context SET todo_hub = 2 WHERE task_id = 'glade'").run()).toThrow(/CHECK/)

  // And what a task's agent owes goes with the task.
  oweFilings(db, 'glade', [{ kind: ChildKind.Watcher, key: 'toolu_monitor' }], 5)
  expect(listOwedFilings(db, 'glade')).toEqual([{ kind: ChildKind.Watcher, key: 'toolu_monitor' }])
  db.prepare("DELETE FROM tasks WHERE id = 'glade'").run()
  expect(db.prepare('SELECT COUNT(*) FROM owed_filings').pluck().get()).toBe(0)
  db.close()
})
