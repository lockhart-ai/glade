// Test helpers: a migrated database in a temporary folder, and made-up sample rows.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { Effort, type Task, type Workspace } from '../../../shared/domain'
import { openAppDatabase } from '../database'
import { createTask } from './tasks'
import { createWorkspace } from './workspaces'

export interface TestDatabase {
  readonly db: Database
  /** Closes the database and deletes its folder. */
  close(): void
}

/** Opens a fresh app database, migrated to the latest schema, in a new temporary folder. */
export function openTestDatabase(): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'glade-repo-'))
  const { db } = openAppDatabase(dir)
  return {
    db,
    close() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function sampleWorkspace(db: Database, rootPath = '/code/acme-api'): Workspace {
  return createWorkspace(db, { name: 'Acme API', rootPath }, 1_000)
}

export function sampleTask(db: Database, workspaceId: string, now = 2_000): Task {
  return createTask(db, { workspaceId, model: 'claude-sample-1', effort: Effort.Medium }, now)
}
