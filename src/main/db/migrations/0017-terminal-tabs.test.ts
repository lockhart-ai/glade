import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { terminalTabsMigration } from './0017-terminal-tabs'

it('is migration 17', () => {
  expect(MIGRATIONS[16]).toBe(terminalTabsMigration)
})

it('starts with no terminal tabs, each with no output until it has some', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 16))

  migrate(db, MIGRATIONS)

  expect(db.prepare('SELECT COUNT(*) FROM terminal_tabs').pluck().get()).toBe(0)
  db.prepare(
    "INSERT INTO terminal_tabs (id, name, cwd, position, created_at) VALUES ('t', NULL, '/code/api', 0, 1)",
  ).run()
  expect(db.prepare("SELECT scrollback FROM terminal_tabs WHERE id = 't'").pluck().get()).toBe('')
  db.close()
})
