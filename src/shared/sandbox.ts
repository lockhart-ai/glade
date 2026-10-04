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

/**
 * What applying a change to the grants did to the running sandboxed sessions it covers, by task id. A task with no
 * running session, or whose session started with the sandbox off, is in none of the lists: its next session starts with
 * its grants.
 */
export interface SandboxApplyResult {
  /** The tasks whose session has the change. */
  readonly applied: readonly string[]
  /**
   * The tasks whose session wouldn't take it, and was closed rather than left running on other bounds: each stopped on
   * the sandbox's error, and its next session starts with the grants as saved.
   */
  readonly closed: readonly string[]
  /** The tasks whose session was still applying it when the caller was answered, having waited on one task only. */
  readonly pending: readonly string[]
}

/** What a sandbox permission card asks for (#450): a folder, a domain, or to run one command outside the sandbox. */
export enum SandboxAskKind {
  Folder = 'folder',
  Domain = 'domain',
  Outside = 'outside',
}

/** The agent wants to read, or to write to, a folder outside its grants. */
export interface SandboxFolderAsk {
  readonly kind: SandboxAskKind.Folder
  /** The folder a grant would name, as grants keep it: absolute, where it really is. */
  readonly path: string
  /** What a grant would give: a read asks for read-only, a write for read-write. */
  readonly access: FolderAccess
}

/** The agent wants to reach a domain that isn't granted: a command's connection, or `WebFetch`. */
export interface SandboxDomainAsk {
  readonly kind: SandboxAskKind.Domain
  /** The host, lower case. */
  readonly domain: string
  /** The command whose connection waits on the answer; null for `WebFetch`, and when Glade can't tell which it is. */
  readonly command: string | null
  /** What the agent said that command is for; null when it didn't, or there's no command. */
  readonly commandDescription: string | null
}

/** The agent wants to run one command outside the sandbox: it can only be allowed once. */
export interface SandboxOutsideAsk {
  readonly kind: SandboxAskKind.Outside
}

/** What a sandbox permission request asks for. */
export type SandboxAsk = SandboxFolderAsk | SandboxDomainAsk | SandboxOutsideAsk

/** A request for something a grant can give: a folder or a domain. */
export type SandboxGrantAsk = SandboxFolderAsk | SandboxDomainAsk

/** The scopes a permission card can grant a folder or domain to: Glade-wide grants are made in Settings only. */
export type CardGrantScope = SandboxGrantScope.Task | SandboxGrantScope.Workspace

/** A macOS home folder, `/Users/<name>`, at the start of a path: any but `/Users/Shared`, which is nobody's. */
const HOME_PREFIX = /^\/Users\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/

/**
 * Shortens a path under the user's home folder to start with `~`, as the designs show folders (`~/code/api`). The
 * sandboxed renderer can't ask for the home folder, so this recognises the macOS `/Users/<name>` layout; the shared
 * folder beside the home folders, `/Users/Shared`, is left as it is.
 */
export function shortenHomePath(path: string): string {
  return path.replace(HOME_PREFIX, '~')
}

/** What a folder request does with its folder, as every permission line says it: "read" or "write to". */
export function folderVerb(access: FolderAccess): string {
  return access === FolderAccess.Read ? 'read' : 'write to'
}

/**
 * What a sandbox request is about, in the words every permission line uses (`docs/design/README.md`, the shield):
 * "read ~/code/acme-web", "write to ~/.cache/uv", "reach registry.npmjs.org" or "run outside the sandbox".
 */
export function sandboxAskPhrase(ask: SandboxAsk): string {
  switch (ask.kind) {
    case SandboxAskKind.Folder:
      return `${folderVerb(ask.access)} ${shortenHomePath(ask.path)}`
    case SandboxAskKind.Domain:
      return `reach ${ask.domain}`
    case SandboxAskKind.Outside:
      return 'run outside the sandbox'
  }
}

/** The grant Allow for this task or Allow for this workspace makes for a folder or domain request. */
export function grantFor(ask: SandboxGrantAsk): Grant {
  switch (ask.kind) {
    case SandboxAskKind.Folder:
      return { kind: SandboxGrantKind.Folder, path: ask.path, access: ask.access }
    case SandboxAskKind.Domain:
      return { kind: SandboxGrantKind.Domain, domain: ask.domain }
  }
}
