import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import {
  coversAccess,
  FolderAccess,
  mergeGrants,
  OtherAgents,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type GrantKey,
  type GrantedTask,
  type SandboxGrant,
  type SandboxGrantTarget,
} from '../../../shared/sandbox'
import { Row } from './rows'

/** A grant to add: what it allows, and the tasks it covers. */
export interface NewSandboxGrant {
  readonly target: SandboxGrantTarget
  readonly grant: Grant
}

/** Which grant of a scope: a folder by its path (whatever its access), or a domain. */
export type SandboxGrantKey = GrantKey

/** What adding or changing a grant did to the scope's grants. */
export enum SandboxGrantChange {
  /** A folder or domain the scope didn't have. */
  Added = 'added',
  /** A folder the scope had, its access changed. */
  Changed = 'changed',
  /** Nothing: the scope already had it, as wide or wider (or, changing it, had no such folder). */
  Unchanged = 'unchanged',
}

/** The tasks a grant covers, as its row's columns. */
interface GrantOwner {
  readonly scope: SandboxGrantScope
  readonly workspaceId: string | null
  readonly taskId: string | null
}

const TABLE = 'sandbox_grants'
const COLUMNS = 'scope, workspace_id, task_id, kind, value, access, is_file, name, created_at'
const SCOPES = Object.values(SandboxGrantScope)
const KINDS = Object.values(SandboxGrantKind)
const ACCESSES = Object.values(FolderAccess)
const AGENTS = Object.values(OtherAgents)
/** Picks out one scope's grants, given its owner's columns. */
const SAME_OWNER = 'scope = @scope AND workspace_id IS @workspaceId AND task_id IS @taskId'

function ownerOf(target: SandboxGrantTarget): GrantOwner {
  switch (target.scope) {
    case SandboxGrantScope.Glade:
      return { scope: target.scope, workspaceId: null, taskId: null }
    case SandboxGrantScope.Workspace:
      return { scope: target.scope, workspaceId: target.workspaceId, taskId: null }
    case SandboxGrantScope.Task:
      return { scope: target.scope, workspaceId: null, taskId: target.taskId }
  }
}

/** The value a grant is stored and looked up by: a folder's path, a domain, an MCP server's key, or which agents. */
function valueOf(key: SandboxGrantKey): string {
  switch (key.kind) {
    case SandboxGrantKind.Folder:
      return key.path
    case SandboxGrantKind.Domain:
      return key.domain
    case SandboxGrantKind.McpServer:
      return key.server
    case SandboxGrantKind.Agents:
      return key.agents
  }
}

function parseTarget(row: Row): SandboxGrantTarget {
  const scope = row.oneOf('scope', SCOPES)
  switch (scope) {
    case SandboxGrantScope.Glade:
      return { scope }
    case SandboxGrantScope.Workspace:
      return { scope, workspaceId: row.text('workspace_id') }
    case SandboxGrantScope.Task:
      return { scope, taskId: row.text('task_id') }
  }
}

function parseGrant(row: Row): Grant {
  const kind = row.oneOf('kind', KINDS)
  switch (kind) {
    case SandboxGrantKind.Folder: {
      const folder = { kind, path: row.text('value'), access: row.oneOf('access', ACCESSES) } as const
      return row.integer('is_file') === 1 ? { ...folder, file: true } : folder
    }
    case SandboxGrantKind.Domain:
      return { kind, domain: row.text('value') }
    case SandboxGrantKind.McpServer:
      return { kind, server: row.text('value'), name: row.text('name') }
    case SandboxGrantKind.Agents:
      return { kind, agents: row.oneOf('value', AGENTS) }
  }
}

function parseSandboxGrant(raw: unknown): SandboxGrant {
  const row = new Row(TABLE, raw)
  return { target: parseTarget(row), grant: parseGrant(row), createdAt: row.integer('created_at') }
}

/** The access a scope's folder has now, or null when the scope has no such folder. */
function folderAccess(db: Database, owner: GrantOwner, path: string): FolderAccess | null {
  const raw: unknown = db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE ${SAME_OWNER} AND kind = 'folder' AND value = @value`)
    .get({ ...owner, value: path })
  if (raw === undefined) return null
  return new Row(TABLE, raw).oneOf('access', ACCESSES)
}

/**
 * Grants a folder (or a single file), a domain, an MCP server or other agents to a scope. One the scope already has
 * stays as it was, granted when it first was, and a folder or a file as it first was (an MCP server under the name it
 * first had), except that a folder granted read-only and now read-write is upgraded: adding never narrows a folder's
 * access (see `setSandboxFolderAccess`). Answers with what changed.
 */
export function addSandboxGrant(
  db: Database,
  { target, grant }: NewSandboxGrant,
  now: EpochMs = Date.now(),
): SandboxGrantChange {
  const owner = ownerOf(target)
  return db.transaction((): SandboxGrantChange => {
    if (grant.kind === SandboxGrantKind.Folder) {
      const access = folderAccess(db, owner, grant.path)
      if (access !== null) {
        if (coversAccess(access, grant.access)) return SandboxGrantChange.Unchanged
        setAccess(db, owner, grant.path, grant.access)
        return SandboxGrantChange.Changed
      }
    }
    const { changes } = db
      .prepare(
        `INSERT INTO ${TABLE} (${COLUMNS})
         VALUES (@scope, @workspaceId, @taskId, @kind, @value, @access, @isFile, @name, @createdAt)
         ON CONFLICT DO NOTHING`,
      )
      .run({
        ...owner,
        kind: grant.kind,
        value: valueOf(grant),
        access: grant.kind === SandboxGrantKind.Folder ? grant.access : null,
        isFile: grant.kind === SandboxGrantKind.Folder && grant.file === true ? 1 : 0,
        name: grant.kind === SandboxGrantKind.McpServer ? grant.name : null,
        createdAt: now,
      })
    return changes > 0 ? SandboxGrantChange.Added : SandboxGrantChange.Unchanged
  })()
}

function setAccess(db: Database, owner: GrantOwner, path: string, access: FolderAccess): void {
  db.prepare(`UPDATE ${TABLE} SET access = @access WHERE ${SAME_OWNER} AND kind = 'folder' AND value = @value`).run({
    ...owner,
    value: path,
    access,
  })
}

/**
 * Sets the access a scope's granted folder has, wider or narrower: a read-write folder downgraded to read-only, say.
 * Answers `Changed`, or `Unchanged` when the scope has no such folder or it already has that access.
 */
export function setSandboxFolderAccess(
  db: Database,
  target: SandboxGrantTarget,
  path: string,
  access: FolderAccess,
): SandboxGrantChange {
  const owner = ownerOf(target)
  return db.transaction((): SandboxGrantChange => {
    const current = folderAccess(db, owner, path)
    if (current === null || current === access) return SandboxGrantChange.Unchanged
    setAccess(db, owner, path, access)
    return SandboxGrantChange.Changed
  })()
}

/** Takes a folder, domain, MCP server or other agents back from a scope. Answers whether the scope had it. */
export function removeSandboxGrant(db: Database, target: SandboxGrantTarget, key: SandboxGrantKey): boolean {
  const { changes } = db
    .prepare(`DELETE FROM ${TABLE} WHERE ${SAME_OWNER} AND kind = @kind AND value = @value`)
    .run({ ...ownerOf(target), kind: key.kind, value: valueOf(key) })
  return changes > 0
}

/** One scope's grants, of every kind, in the order they were first granted. */
export function listSandboxGrants(db: Database, target: SandboxGrantTarget): SandboxGrant[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE ${SAME_OWNER} ORDER BY created_at, rowid`)
    .all(ownerOf(target))
    .map(parseSandboxGrant)
}

/**
 * Every grant that covers a task, each folder and domain once (`mergeGrants`): the Glade-wide ones, its workspace's and
 * its own, a folder granted at more than one scope with the widest access any gives it. In the order each was first
 * granted.
 */
export function listGrantsCovering(db: Database, task: GrantedTask): Grant[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM ${TABLE}
       WHERE scope = 'glade' OR (scope = 'workspace' AND workspace_id = ?) OR (scope = 'task' AND task_id = ?)
       ORDER BY created_at, rowid`,
    )
    .all(task.workspaceId, task.id)
  return mergeGrants(rows.map((raw) => parseSandboxGrant(raw).grant))
}
