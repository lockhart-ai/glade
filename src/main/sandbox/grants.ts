/**
 * Sandbox grants (P15-04, #449; #445 "Grants"): the folders and domains a task's agent may use beyond its workspace
 * root, Glade-wide, for a workspace or for a task, kept in `sandbox_grants` and applied to the agent's session.
 *
 * - **Applied after start, never at start.** `applyFlagSettings` can't narrow what a session started with
 *   (`docs/sdk-notes.md` §15), so a session starts with only the sandbox's fixed parts, and straight after it starts or
 *   resumes, before its first message, the runner applies the task's whole overlay: the fixed parts plus every grant
 *   that covers the task (`SandboxOverlayBuilder`). So grants survive relaunches.
 * - **Live changes.** Adding, changing or removing a grant here saves it, then rebuilds the overlay of every running
 *   session it covers (one task, a workspace's tasks, or all of them) and applies it, without restarting any. Removing
 *   a folder, or downgrading it to read-only, takes effect from the session's next call. A host a session was already
 *   allowed to reach stays reachable until it restarts: an SDK limitation.
 * - Each call resolves once the sessions it covers have the change, so a card (P15-05) can answer the agent only once
 *   its retry will see the grant. A session that refuses it is logged; the grant stays saved, for its next start.
 * - Grants live only in Glade's database and the session's options: nothing is written to the user's files.
 */
import { isAbsolute, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import type { PermissionMode } from '../../shared/domain'
import {
  FolderAccess,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import type { SandboxFlagSettings } from '../agent/backend'
import type { AgentRunner } from '../agent/runner'
import { CommandFailure } from '../bridge/errors'
import {
  addSandboxGrant,
  removeSandboxGrant,
  SandboxGrantChange,
  setSandboxFolderAccess,
  type NewSandboxGrant,
  type SandboxGrantKey,
} from '../db/repositories/sandbox-grants'
import { getTask } from '../db/repositories/tasks'
import { getWorkspace } from '../db/repositories/workspaces'

/** What a task's sandbox overlay is built from. */
export interface SandboxOverlayInput {
  /** The task's workspace root: always readable and writable. */
  readonly root: string
  /** The task's permission mode, which sets whether a sandboxed command runs without asking. */
  readonly permissionMode: PermissionMode
  /** Every grant that covers the task, each folder and domain once (`listGrantsCovering`). */
  readonly grants: readonly Grant[]
}

/**
 * Builds the whole of a task's sandbox overlay, for `applyFlagSettings`: the `sandbox` with its fixed parts plus the
 * granted folders, and the `permissions` the grants become (read-only folders as `Read(//<folder>/**)` rules and
 * domains as `WebFetch(domain:…)` rules in `allow`, read-write folders as `additionalDirectories`). Null while the
 * sandbox is off: then nothing is applied. P15-03 (#448) owns the builder; the runner takes it as an option.
 */
export type SandboxOverlayBuilder = (input: SandboxOverlayInput) => SandboxFlagSettings | null

/** What changing grants needs: the database, and the runner whose sessions get the change. */
export interface SandboxGrantsContext {
  readonly db: Database
  readonly runner: Pick<AgentRunner, 'applySandboxGrants'>
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

/** A folder as grants keep it: absolute and resolved, with no trailing slash. @throws CommandFailure when relative. */
export function grantedFolder(path: string): string {
  if (!isAbsolute(path)) throw new CommandFailure(BridgeErrorCode.InvalidRequest, `Not an absolute path: ${path}`)
  return resolve(path)
}

/** A domain as grants keep it: a bare host, lower case. @throws CommandFailure for anything else. */
export function grantedDomain(domain: string): string {
  const host = domain.trim().toLowerCase()
  if (!/^[a-z0-9*][a-z0-9.*-]*$/.test(host)) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, `Not a domain: ${domain}`)
  }
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

function normalizedKey(key: SandboxGrantKey): SandboxGrantKey {
  switch (key.kind) {
    case SandboxGrantKind.Folder:
      return { kind: key.kind, path: grantedFolder(key.path) }
    case SandboxGrantKind.Domain:
      return { kind: key.kind, domain: grantedDomain(key.domain) }
  }
}

/**
 * Grants a folder or domain to a scope (`addSandboxGrant`: no duplicates, and a read-only folder granted read-write is
 * upgraded), then applies it to the running sessions it covers. Resolves with what changed once they have it.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a relative folder or a value
 * that isn't a domain.
 */
export async function grantSandboxAccess(
  { db, runner }: SandboxGrantsContext,
  { target, grant }: NewSandboxGrant,
): Promise<SandboxGrantChange> {
  requireTarget(db, target)
  const change = addSandboxGrant(db, { target, grant: normalizedGrant(grant) })
  if (change !== SandboxGrantChange.Unchanged) await runner.applySandboxGrants(target)
  return change
}

/**
 * Sets a scope's granted folder's access, wider or narrower (a read-write folder downgraded to read-only, say), then
 * applies it to the running sessions it covers. Resolves with what changed once they have it: `Unchanged` when the
 * scope has no such folder or it already has that access.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a relative folder.
 */
export async function changeSandboxFolderAccess(
  { db, runner }: SandboxGrantsContext,
  target: SandboxGrantTarget,
  path: string,
  access: FolderAccess,
): Promise<SandboxGrantChange> {
  requireTarget(db, target)
  const change = setSandboxFolderAccess(db, target, grantedFolder(path), access)
  if (change !== SandboxGrantChange.Unchanged) await runner.applySandboxGrants(target)
  return change
}

/**
 * Takes a folder or domain back from a scope, then takes it out of the running sessions it covered. Resolves with
 * whether the scope had it, once they've lost it.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a relative folder or a value
 * that isn't a domain.
 */
export async function revokeSandboxGrant(
  { db, runner }: SandboxGrantsContext,
  target: SandboxGrantTarget,
  key: SandboxGrantKey,
): Promise<boolean> {
  requireTarget(db, target)
  const removed = removeSandboxGrant(db, target, normalizedKey(key))
  if (removed) await runner.applySandboxGrants(target)
  return removed
}
