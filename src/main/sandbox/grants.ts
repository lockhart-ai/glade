/**
 * Sandbox grants (P15-04, #449; #445 "Grants"): the folders and domains a task's agent may use beyond its workspace
 * root, Glade-wide, for a workspace or for a task, kept in `sandbox_grants` and applied to the agent's session.
 *
 * - **Applied after start, never at start.** `applyFlagSettings` can't narrow what a session started with
 *   (`docs/sdk-notes.md` §15), so a sandboxed session starts with only the sandbox's fixed parts, and straight after it
 *   starts or resumes, before its first message, the runner applies the whole overlay (`../agent/sandbox`): the fixed
 *   parts plus every grant that covers the task, read from here (`taskSandboxGrants`). So grants survive relaunches.
 * - **Live changes.** Adding, changing or removing a grant here saves it, then has every running sandboxed session it
 *   covers (one task, a workspace's tasks, or all of them) read its grants again and take the whole overlay, without
 *   restarting any. The session's file tools are held to the new grants at once, and its commands from the overlay on:
 *   removing a folder, or downgrading it to read-only, takes effect from the session's next call. A host a session was
 *   already allowed to reach stays reachable until it restarts: an SDK limitation.
 * - Each call resolves once the sessions it covers have answered, with which have the change and which wouldn't take
 *   it (`SandboxApplyResult`), so a card (P15-05) can answer the agent only once its retry will see the grant, and say
 *   so when it won't. A card waits on the asking session alone (`awaitTaskId`): the others apply in the background.
 * - A session that won't take an overlay is closed, its task stopping on the sandbox's error, as at start: it's never
 *   left running on other bounds than the grants say. The grant stays saved, and the task's next session starts with it.
 *   Every call applies the scope's grants again, changed or not.
 * - **One folder, one grant.** A folder is kept by where it really is (`canonicalPath`: links followed and the disk's
 *   own case as far as the path exists, the rest as written), and found again by that, however it's spelt.
 * - **Only what the sandbox can take is saved.** A grant is checked here by the sandbox's own rules (`usableGrants`), so
 *   nothing saved is later left out of a session's settings: a folder is absolute, never the whole disk, and has no
 *   glob character; a domain is a bare host, or `*.` and a host of two labels or more (never a whole top-level domain).
 * - Grants live only in Glade's database and the session's flag settings: nothing is written to the user's files.
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import {
  coversAccess,
  FolderAccess,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type GrantedTask,
  type SandboxApplyResult,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import type { AgentRunner, SandboxApplyOptions } from '../agent/runner'
import {
  GrantProblem,
  sandboxFolder,
  usableGrants,
  type SandboxFolderGrant,
  type SandboxGrants,
} from '../agent/sandbox'
import { CommandFailure } from '../bridge/errors'
import {
  addSandboxGrant,
  listGrantsCovering,
  listSandboxGrants,
  removeSandboxGrant,
  SandboxGrantChange,
  setSandboxFolderAccess,
  type NewSandboxGrant,
  type SandboxGrantKey,
} from '../db/repositories/sandbox-grants'
import { getTask } from '../db/repositories/tasks'
import { getWorkspace } from '../db/repositories/workspaces'
import { hostMatches } from '../agent/sandbox-requests'
import { canonicalKey, canonicalPath, keyInside, pathKey } from '../permissions/canonical-path'

/** What changing grants needs: the database, and the runner whose sessions get the change. */
export interface SandboxGrantsContext {
  readonly db: Database
  readonly runner: Pick<AgentRunner, 'applySandboxGrants'>
}

/** What granting, or changing a folder's access, did: to the scope's grants, and to the running sessions. */
export interface SandboxGrantOutcome {
  readonly change: SandboxGrantChange
  /** Which running sessions have the grants now, and which wouldn't take them (`AgentRunner.applySandboxGrants`). */
  readonly sessions: SandboxApplyResult
}

/** What taking a grant back did: whether the scope had it, and what the running sessions did with the change. */
export interface SandboxRevokeOutcome {
  readonly removed: boolean
  /** Which running sessions have lost it, and which wouldn't take the change and were closed. */
  readonly sessions: SandboxApplyResult
}

/** Grants as a session's sandbox takes them (`../agent/sandbox`): the folders, each with its access, and the domains. */
export function sandboxGrantsOf(grants: readonly Grant[]): SandboxGrants {
  const folders: SandboxFolderGrant[] = []
  const domains: string[] = []
  for (const grant of grants) {
    switch (grant.kind) {
      case SandboxGrantKind.Folder:
        folders.push({ path: grant.path, access: grant.access })
        break
      case SandboxGrantKind.Domain:
        domains.push(grant.domain)
        break
    }
  }
  return { folders, domains }
}

/**
 * Everything granted to a task beyond its workspace root, for its session's sandbox: the Glade-wide grants, its
 * workspace's and its own, each folder once with the widest access any gives it (`listGrantsCovering`). What the
 * runner reads as a session starts, and again when the grants change (`AgentRunnerOptions.sandboxGrants`).
 */
export function taskSandboxGrants(db: Database, task: GrantedTask): SandboxGrants {
  return sandboxGrantsOf(listGrantsCovering(db, task))
}

/** Checks the task or workspace a grant is for exists. @throws CommandFailure `not_found` when it doesn't. */
function requireTarget(db: Database, target: SandboxGrantTarget): void {
  switch (target.scope) {
    case SandboxGrantScope.Glade:
      return
    case SandboxGrantScope.Workspace:
      if (getWorkspace(db, target.workspaceId) === undefined) {
        throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${target.workspaceId}`)
      }
      return
    case SandboxGrantScope.Task:
      if (getTask(db, target.taskId) === undefined) {
        throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${target.taskId}`)
      }
  }
}

/** Why a value can't be granted, in words. */
function problemText(problem: GrantProblem): string {
  switch (problem) {
    case GrantProblem.NotAbsolute:
      return 'not an absolute path'
    case GrantProblem.WholeDisk:
      return 'the whole disk'
    case GrantProblem.Pattern:
      return 'a pattern, not a folder'
    case GrantProblem.NotAHost:
      return 'not a domain'
  }
}

/** The failure for a value that can't be granted. */
function notGrantable(value: string, problem: GrantProblem): CommandFailure {
  return new CommandFailure(BridgeErrorCode.InvalidRequest, `Can't grant "${value}": ${problemText(problem)}`)
}

/**
 * A folder the sandbox's settings can take, as they'd list it (`usableGrants`): absolute, tidied, not the whole disk,
 * with no glob character.
 *
 * @throws CommandFailure `invalid_request` for any other.
 */
function usableFolder(path: string): string {
  const [rejection] = usableGrants({ folders: [{ path, access: FolderAccess.Read }], domains: [] }).rejected
  if (rejection !== undefined) throw notGrantable(path, rejection.problem)
  return sandboxFolder(path)
}

/**
 * A folder as grants keep it, so one folder is one grant however it's spelt: where it really is (`canonicalPath`),
 * with links followed (as `/tmp` is `/private/tmp`) and each name in the disk's own case as far as the path exists,
 * and the rest as written, so a folder granted before it's made is kept the same way once it is. A path that can't be
 * resolved (a loop of links) is kept as written.
 *
 * @throws CommandFailure `invalid_request` for a path the sandbox can't take (`usableFolder`), as written or resolved.
 */
export function grantedFolder(path: string): string {
  const written = usableFolder(path)
  return usableFolder(canonicalPath(written) ?? written)
}

/**
 * A domain as grants keep it, lower case: a bare host (`registry.npmjs.org`, `localhost`), or every host under one
 * (`*.acme.dev`: a leading `*.`, then a host of two labels or more, so never a whole top-level domain).
 *
 * @throws CommandFailure `invalid_request` for anything else: what the sandbox can't take (a scheme, port or path, a
 * `*` anywhere else, an empty label), or `*.` over a single label.
 */
export function grantedDomain(domain: string): string {
  const host = domain.trim().toLowerCase()
  const { rejected } = usableGrants({ folders: [], domains: [host] })
  const wholeTopLevel = host.startsWith('*.') && !host.slice(2).includes('.')
  if (rejected.length > 0 || wholeTopLevel) throw notGrantable(domain, GrantProblem.NotAHost)
  return host
}

/** A grant as grants keep it (`grantedFolder`, `grantedDomain`). */
export function normalizedGrant(grant: Grant): Grant {
  switch (grant.kind) {
    case SandboxGrantKind.Folder:
      return { ...grant, path: grantedFolder(grant.path) }
    case SandboxGrantKind.Domain:
      return { ...grant, domain: grantedDomain(grant.domain) }
  }
}

/** What two spellings of one folder share (`canonicalKey`); a path that can't be resolved, as written. */
function folderKey(path: string): string {
  return canonicalKey(path) ?? pathKey(path)
}

/**
 * The folders a scope has been granted that are the folder `path` is, as each is kept: usually one, kept as `path`
 * itself; another spelling when the folder has moved under its name since (made, in another case, after it was
 * granted, or replaced by a link).
 */
function keptFolders(db: Database, target: SandboxGrantTarget, path: string): string[] {
  const key = folderKey(path)
  return listSandboxGrants(db, target).flatMap(({ grant }) =>
    grant.kind === SandboxGrantKind.Folder && folderKey(grant.path) === key ? [grant.path] : [],
  )
}

/** The keys a scope keeps a grant under (`keptFolders`, `grantedDomain`): none for a folder it doesn't have. */
function keptKeys(db: Database, target: SandboxGrantTarget, key: SandboxGrantKey): SandboxGrantKey[] {
  switch (key.kind) {
    case SandboxGrantKind.Folder:
      return keptFolders(db, target, grantedFolder(key.path)).map((path) => ({ kind: key.kind, path }))
    case SandboxGrantKind.Domain:
      return [{ kind: key.kind, domain: grantedDomain(key.domain) }]
  }
}

/** A grant to save, a folder under the spelling the scope already keeps it by, if it has it. */
function grantToSave(db: Database, target: SandboxGrantTarget, grant: Grant): Grant {
  const normalized = normalizedGrant(grant)
  if (normalized.kind !== SandboxGrantKind.Folder) return normalized
  const [kept] = keptFolders(db, target, normalized.path)
  return kept === undefined ? normalized : { ...normalized, path: kept }
}

/**
 * Saves a grant of a folder or domain to a scope (`addSandboxGrant`: no duplicates, and a read-only folder granted
 * read-write is upgraded), without applying it to any session: for a permission card's answer, which saves the grant
 * with the answer and has the runner apply it (`../permissions/permissions`). Answers with what changed.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a folder or domain the
 * sandbox can't take.
 */
export function saveSandboxGrant(db: Database, { target, grant }: NewSandboxGrant): SandboxGrantChange {
  requireTarget(db, target)
  return addSandboxGrant(db, { target, grant: grantToSave(db, target, grant) })
}

/**
 * Grants a folder or domain to a scope (`saveSandboxGrant`), then applies the scope's grants to the running sessions
 * they cover: always, even when the scope already had the grant. Resolves with what changed and which sessions have
 * it, once they've answered (or, given `awaitTaskId`, once that task's has).
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a folder or domain the
 * sandbox can't take.
 */
export async function grantSandboxAccess(
  { db, runner }: SandboxGrantsContext,
  grant: NewSandboxGrant,
  options?: SandboxApplyOptions,
): Promise<SandboxGrantOutcome> {
  const change = saveSandboxGrant(db, grant)
  return { change, sessions: await runner.applySandboxGrants(grant.target, options) }
}

/** The scope whose grant gives a task a folder with at least an access, or a domain: the narrowest that does. */
export function grantingScope(db: Database, task: GrantedTask, grant: Grant): SandboxGrantScope | null {
  const targets: readonly SandboxGrantTarget[] = [
    { scope: SandboxGrantScope.Task, taskId: task.id },
    { scope: SandboxGrantScope.Workspace, workspaceId: task.workspaceId },
    { scope: SandboxGrantScope.Glade },
  ]
  const gives = (held: Grant): boolean => {
    switch (grant.kind) {
      case SandboxGrantKind.Folder:
        return (
          held.kind === SandboxGrantKind.Folder &&
          coversAccess(held.access, grant.access) &&
          keyInside(folderKey(grant.path), folderKey(held.path))
        )
      case SandboxGrantKind.Domain:
        return held.kind === SandboxGrantKind.Domain && hostMatches(grant.domain, held.domain)
    }
  }
  const found = targets.find((target) => listSandboxGrants(db, target).some(({ grant: held }) => gives(held)))
  return found?.scope ?? null
}

/**
 * Sets a scope's granted folder's access, wider or narrower (a read-write folder downgraded to read-only, say), then
 * applies the scope's grants to the running sessions they cover, changed or not. Resolves with what changed
 * (`Unchanged` when the scope has no such folder or it already has that access) and which sessions have it.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a folder the sandbox can't
 * take.
 */
export async function changeSandboxFolderAccess(
  { db, runner }: SandboxGrantsContext,
  target: SandboxGrantTarget,
  path: string,
  access: FolderAccess,
  options?: SandboxApplyOptions,
): Promise<SandboxGrantOutcome> {
  requireTarget(db, target)
  const changes = keptFolders(db, target, grantedFolder(path)).map((kept) =>
    setSandboxFolderAccess(db, target, kept, access),
  )
  const changed = changes.includes(SandboxGrantChange.Changed)
  return {
    change: changed ? SandboxGrantChange.Changed : SandboxGrantChange.Unchanged,
    sessions: await runner.applySandboxGrants(target, options),
  }
}

/**
 * Takes a folder or domain back from a scope, then applies the scope's grants to the running sessions they covered,
 * whether or not the scope had it. Resolves with whether it did and which sessions have lost it.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a folder or domain the
 * sandbox can't take.
 */
export async function revokeSandboxGrant(
  { db, runner }: SandboxGrantsContext,
  target: SandboxGrantTarget,
  key: SandboxGrantKey,
  options?: SandboxApplyOptions,
): Promise<SandboxRevokeOutcome> {
  requireTarget(db, target)
  const removed = keptKeys(db, target, key).map((kept) => removeSandboxGrant(db, target, kept))
  return { removed: removed.includes(true), sessions: await runner.applySandboxGrants(target, options) }
}
