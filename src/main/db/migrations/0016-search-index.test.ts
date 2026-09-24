import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { searchTasks } from '../repositories/search'
import { MIGRATIONS } from '.'
import { SEARCH_TRIGGERS, searchIndexMigration } from './0016-search-index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 16', () => {
  expect(MIGRATIONS[15]).toBe(searchIndexMigration)
})

it('indexes the tasks and messages already there', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 15))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', 'Add rate limiting', 'Return 429 with a Retry-After header.', 'Throttling the views.', 'active',
      'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO messages (id, task_id, seq, role, body, turn, created_at)
    VALUES ('m', 't', 1, 'user', 'Give /search its own throttle scope.', 1, 2)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(searchTasks(db, 'w', 'retry-after').map(({ field }) => field)).toEqual(['objective'])
  expect(searchTasks(db, 'w', 'throttl').map(({ field }) => field)).toEqual(['status'])
  expect(searchTasks(db, 'w', 'scope').map(({ field }) => field)).toEqual(['message'])
  expect(searchTasks(db, 'w', 'rate').map(({ field }) => field)).toEqual(['title'])
  db.exec("INSERT INTO search_fts (search_fts) VALUES ('integrity-check')")
  db.close()
})

it('leaves every search trigger in the latest schema, which a later rebuild of tasks or messages would drop', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS)
  const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").pluck().all()
  expect(triggers).toEqual(expect.arrayContaining([...SEARCH_TRIGGERS]))
  db.close()
})
