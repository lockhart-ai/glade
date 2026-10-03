/**
 * Sandbox grants (P15, #445, "Grants"): the folders and network domains a task's agent may use beyond its workspace
 * root, granted for one task, for every task in a workspace, or Glade-wide. Nothing is granted by default.
 */
import type { EpochMs } from './domain'

/** Which tasks a grant covers. */
export enum SandboxGrantScope {
  /** Every task, in every workspace: Settings › Agent's lists. */
  Glade = 'glade',
  /** Every task in one workspace: Settings › Workspace's lists, or Allow for this workspace on a card. */
  Workspace = 'workspace',
  /** One task: Allow for this task on a card. It ends with the task. */
  Task = 'task',
}

/** What a grant lets the agent use. */
export enum SandboxGrantKind {
  Folder = 'folder',
  Domain = 'domain',
}

/** How a granted folder may be used: a read grants read-only, a write read-write. */
export enum FolderAccess {
  Read = 'read',
  ReadWrite = 'read_write',
}

/** The tasks a grant covers: all of them, a workspace's, or one. */
export type SandboxGrantTarget =
  | { readonly scope: SandboxGrantScope.Glade }
  | { readonly scope: SandboxGrantScope.Workspace; readonly workspaceId: string }
  | { readonly scope: SandboxGrantScope.Task; readonly taskId: string }

/** A folder the agent may read, or read and write: its commands and its file tools alike. */
export interface FolderGrant {
  readonly kind: SandboxGrantKind.Folder
  /** The folder's absolute path, with no trailing slash. */
  readonly path: string
  readonly access: FolderAccess
}

/** A network domain the agent's commands and `WebFetch` may reach. */
export interface DomainGrant {
  readonly kind: SandboxGrantKind.Domain
  /** The host, lower case, e.g. `registry.npmjs.org`. */
  readonly domain: string
}

/** What one grant allows. */
export type Grant = FolderGrant | DomainGrant

/** One grant as stored: what it allows, the tasks it covers, and when it was first granted. */
export interface SandboxGrant {
  readonly target: SandboxGrantTarget
  readonly grant: Grant
  readonly createdAt: EpochMs
}

/** Whether `access` is at least as wide as `than`. */
export function coversAccess(access: FolderAccess, than: FolderAccess): boolean {
  return access === FolderAccess.ReadWrite || than === FolderAccess.Read
}

/**
 * The grants a task has, from all the grants that cover it (Glade-wide, its workspace's and its own), each once: a
 * folder granted more than once has the widest access any grant gives it, and a domain is listed once. In the order
 * each folder or domain was first granted.
 */
export function mergeGrants(grants: readonly Grant[]): Grant[] {
  const merged = new Map<string, Grant>()
  for (const grant of grants) {
    switch (grant.kind) {
      case SandboxGrantKind.Folder: {
        const key = `folder:${grant.path}`
        const earlier = merged.get(key)
        const widest =
          earlier?.kind === SandboxGrantKind.Folder && coversAccess(earlier.access, grant.access) ? earlier : grant
        merged.set(key, widest)
        break
      }
      case SandboxGrantKind.Domain:
        if (!merged.has(`domain:${grant.domain}`)) merged.set(`domain:${grant.domain}`, grant)
        break
    }
  }
  return [...merged.values()]
}

/** The task a grant may cover: its id and its workspace's. */
export interface GrantedTask {
  readonly id: string
  readonly workspaceId: string
}

/** Whether a grant to `target` covers a task: every one Glade-wide, its workspace's, or its own. */
export function grantCovers(target: SandboxGrantTarget, task: GrantedTask): boolean {
  switch (target.scope) {
    case SandboxGrantScope.Glade:
      return true
    case SandboxGrantScope.Workspace:
      return target.workspaceId === task.workspaceId
    case SandboxGrantScope.Task:
      return target.taskId === task.id
  }
}
