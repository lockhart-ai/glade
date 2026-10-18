import { expect, it } from 'vitest'
import { getToolFingerprints, setToolFingerprints } from '../repositories/session-tool-fingerprints'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { sessionToolFingerprintsMigration } from './0082-session-tool-fingerprints'

it('is migration 82, after every earlier one', () => {
  expect(sessionToolFingerprintsMigration.version).toBe(82)
  expect(MIGRATIONS.indexOf(sessionToolFingerprintsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 82).length)
})

it('leaves every task with nothing recorded: the same as a tool it has never seen', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 82),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, 'session-t')`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(getToolFingerprints(db, 't')).toEqual(new Map())

  // The table is there to use: a fingerprint recorded for one tool is read back, others stay unrecorded.
  setToolFingerprints(db, 't', new Map([['update_todo', 'abc']]))
  expect(getToolFingerprints(db, 't')).toEqual(new Map([['update_todo', 'abc']]))
  db.close()
})
