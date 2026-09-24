import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { EpochMs, Workspace } from '../../../shared/domain'
import { Row } from './rows'

export interface NewWorkspace {
  readonly name: string
  readonly rootPath: string
}

/** The fields `updateWorkspace` can change; the ones left out keep their value. */
export interface WorkspacePatch {
  readonly name?: string
  readonly rootPath?: string
  readonly lastOpenedAt?: EpochMs
}

const COLUMNS = 'id, name, root_path, created_at, last_opened_at'

function parseWorkspace(raw: unknown): Workspace {
  const row = new Row('workspaces', raw)
  return {
    id: row.text('id'),
    name: row.text('name'),
    rootPath: row.text('root_path'),
    createdAt: row.integer('created_at'),
    lastOpenedAt: row.integer('last_opened_at'),
  }
}

/** Adds a workspace, counting its creation as its first opening. Root paths are unique. */
export function createWorkspace(db: Database, input: NewWorkspace, now: EpochMs = Date.now()): Workspace {
  const workspace: Workspace = { id: randomUUID(), ...input, createdAt: now, lastOpenedAt: now }
  db.prepare(`INSERT INTO workspaces (${COLUMNS}) VALUES (@id, @name, @rootPath, @createdAt, @lastOpenedAt)`).run(
    workspace,
  )
  return workspace
}

export function getWorkspace(db: Database, id: string): Workspace | undefined {
  const row: unknown = db.prepare(`SELECT ${COLUMNS} FROM workspaces WHERE id = ?`).get(id)
  return row === undefined ? undefined : parseWorkspace(row)
}

export function getWorkspaceByRoot(db: Database, rootPath: string): Workspace | undefined {
  const row: unknown = db.prepare(`SELECT ${COLUMNS} FROM workspaces WHERE root_path = ?`).get(rootPath)
  return row === undefined ? undefined : parseWorkspace(row)
}

/** Every workspace, oldest first. */
export function listWorkspaces(db: Database): Workspace[] {
  return db.prepare(`SELECT ${COLUMNS} FROM workspaces ORDER BY created_at, name, id`).all().map(parseWorkspace)
}

/** Changes a workspace's fields and returns it updated. Throws if there's no such workspace. */
export function updateWorkspace(db: Database, id: string, patch: WorkspacePatch): Workspace {
  const current = getWorkspace(db, id)
  if (current === undefined) throw new Error(`No workspace ${id}`)
  const updated: Workspace = {
    ...current,
    name: patch.name ?? current.name,
    rootPath: patch.rootPath ?? current.rootPath,
    lastOpenedAt: patch.lastOpenedAt ?? current.lastOpenedAt,
  }
  db.prepare(
    'UPDATE workspaces SET name = @name, root_path = @rootPath, last_opened_at = @lastOpenedAt WHERE id = @id',
  ).run(updated)
  return updated
}
