import { expect, it } from 'vitest'
import { hashLines } from '../../agent/instruction-hash'
import { missingContext, MissingContextKind } from '../../agent/session-context'
import { INSTRUCTION_UPDATES } from '../../agent/system-prompt'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getSessionContext, setSessionContext, type SessionContext } from '../repositories/session-context'
import { MIGRATIONS } from '.'
import { externalIdToldMigration } from './0084-external-id-told'

const ID = 'tasks/2026-10-16-example'

/** A row from before this migration: caught up on the instructions and the hub, told no external id. */
function seed(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    'INSERT INTO session_context (task_id, instructions, instruction_updates, instruction_update_hash, handoff_at, todo_hub) ' +
      'VALUES (?, 1, ?, ?, NULL, 1)',
  ).run('t', INSTRUCTION_UPDATES.length, hashLines(INSTRUCTION_UPDATES))
}

function setUp(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 84),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, 'old-session')`,
  ).run()
  seed(db)
  return db
}

/** What the task's session is missing, with the task's external id `externalId`. */
function missing(db: ReturnType<typeof openDatabase>, externalId: string | null): readonly unknown[] {
  const recorded = getSessionContext(db, 't')
  if (recorded === undefined) throw new Error('No session context')
  return missingContext({ recorded, startedElsewhere: false, handoff: null, externalId, prompt: '', sandboxed: false })
}

it('is migration 84, after every earlier one', () => {
  expect(externalIdToldMigration.version).toBe(84)
  expect(MIGRATIONS.indexOf(externalIdToldMigration)).toBe(MIGRATIONS.filter((m) => m.version < 84).length)
})

it("records none for a row from before it, so a session told none is told the task's external id once", () => {
  const db = setUp()

  migrate(db, MIGRATIONS)

  // Every session recorded here predates the line, so it was told none, whatever its task has now.
  expect(getSessionContext(db, 't')?.externalId).toBeNull()
  expect(missing(db, ID)).toEqual([{ kind: MissingContextKind.ExternalId, externalId: ID }])
  // A task with no external id is never told of one.
  expect(missing(db, null)).toEqual([])

  const told = getSessionContext(db, 't')
  if (told === undefined) throw new Error('No session context')
  setSessionContext(db, 't', { ...told, externalId: ID } satisfies SessionContext)
  expect(missing(db, ID)).toEqual([])
  db.close()
})

it('keeps the external id a session was told, and the rest of what it recorded', () => {
  const db = setUp()

  migrate(db, MIGRATIONS)
  setSessionContext(db, 't', {
    instructions: true,
    instructionUpdates: INSTRUCTION_UPDATES.length,
    instructionUpdateHash: hashLines(INSTRUCTION_UPDATES),
    handoffAt: 1_000,
    externalId: ID,
    sandbox: true,
    todoHub: true,
  })

  expect(getSessionContext(db, 't')).toEqual({
    instructions: true,
    instructionUpdates: INSTRUCTION_UPDATES.length,
    instructionUpdateHash: hashLines(INSTRUCTION_UPDATES),
    handoffAt: 1_000,
    externalId: ID,
    sandbox: true,
    todoHub: true,
  })
  db.close()
})
