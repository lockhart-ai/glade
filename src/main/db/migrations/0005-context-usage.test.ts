import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { contextUsageMigration } from './0005-context-usage'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 5', () => {
  expect(MIGRATIONS[4]).toBe(contextUsageMigration)
})

it('starts existing tasks at 0 used, with the window their model gives', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 4))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  const insert = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, ?, 'high', 1, 1, NULL, NULL)`,
  )
  insert.run('standard', 'claude-sample-1')
  insert.run('extended', 'claude-sample-1[1m]')

  migrate(db, MIGRATIONS)

  expect(getTask(db, 'standard')).toMatchObject({ contextUsedTokens: 0, contextWindowTokens: 200_000 })
  expect(getTask(db, 'extended')).toMatchObject({ contextUsedTokens: 0, contextWindowTokens: 1_000_000 })
  db.close()
})
