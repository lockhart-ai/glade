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
 * - Each call resolves once the sessions it covers have answered, with which have the change and which refused it
 *   (`SandboxApplyResult`), so a card (P15-05) can answer the agent only once its retry will see the grant, and say so
 *   when it won't. A card waits on the asking session alone (`awaitTaskId`): the others apply in the background.
 * - A session that refuses a change is logged, and the grant stays saved. Every call applies the scope's grants again,
 *   changed or not, so repeating it repairs the session; failing that, its next start applies them.
 * - Grants live only in Glade's database and the session's options: nothing is written to the user's files.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import type { PermissionMode } from '../../shared/domain'
import {
  SandboxGrantKind,
  SandboxGrantScope,
  type FolderAccess,
  type Grant,
  type SandboxApplyResult,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import type { SandboxFlagSettings } from '../agent/backend'
import type { AgentRunner, SandboxApplyOptions } from '../agent/runner'
import { isBareHost } from '../agent/sandbox-requests'
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

/** What granting, or changing a folder's access, did: to the scope's grants, and to the running sessions. */
export interface SandboxGrantOutcome {
  readonly change: SandboxGrantChange
  /** Which running sessions have the grants now, and which refused them (`AgentRunner.applySandboxGrants`). */
  readonly sessions: SandboxApplyResult
}

/** What taking a grant back did: whether the scope had it, and what the running sessions did with the change. */
export interface SandboxRevokeOutcome {
  readonly removed: boolean
  /**
   * Which running sessions have lost it, and which refused the change: one that refused can still use the folder or
   * domain until it takes a later overlay, or restarts.
   */
  readonly sessions: SandboxApplyResult
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

/**
 * The characters Claude Code reads as a pattern in a permission rule or a sandbox path: a grant holding one would
 * cover more than the one folder it names.
 */
const GLOB_CHARACTERS = /[*?[\]{}]/

/**
 * A folder's path as written, made tidy without looking at the disk: no `.`, `..`, doubled or trailing slashes.
 *
 * @throws CommandFailure `invalid_request` for a relative path, or one with a glob character (`* ? [ ] { }`).
 */
function lexicalFolder(path: string): string {
  if (!isAbsolute(path)) throw new CommandFailure(BridgeErrorCode.InvalidRequest, `Not an absolute path: ${path}`)
  if (GLOB_CHARACTERS.test(path)) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, `A pattern, not a folder: ${path}`)
  }
  return resolve(path)
}

/**
 * A folder as grants keep it, so one folder is one grant however it's spelt: absolute, and, where the folder exists,
 * its real path (symlinks followed, as `/tmp` is `/private/tmp`, and each name in the case the disk has it). A folder
 * that doesn't exist (yet) is kept as written, tidied (`lexicalFolder`).
 *
 * @throws CommandFailure `invalid_request` for a relative path, or one with a glob character, as written or once
 * resolved.
 */
export function grantedFolder(path: string): string {
  const written = lexicalFolder(path)
  let real: string
  try {
    real = realpathSync.native(written)
  } catch {
    return written
  }
  return lexicalFolder(real)
}

/**
 * The spellings a folder's grant may be kept under: its real path, and the path as written, which is what was kept if
 * it was granted before the folder existed. Taking a grant back, or changing its access, covers both.
 */
function folderSpellings(path: string): string[] {
  return [...new Set([grantedFolder(path), lexicalFolder(path)])]
}

/**
 * A domain as grants keep it, lower case: a bare host (`registry.npmjs.org`, `localhost`), or every host under one
 * (`*.acme.dev`: a leading `*.`, then a host of two labels or more, so never a whole top-level domain).
 *
 * @throws CommandFailure `invalid_request` for anything else: a scheme, port or path, a `*` anywhere else, an empty
 * label.
 */
export function grantedDomain(domain: string): string {
  const host = domain.trim().toLowerCase()
  const under = host.startsWith('*.') ? host.slice(2) : null
  const valid = under === null ? isBareHost(host) : isBareHost(under) && under.includes('.')
  if (!valid) throw new CommandFailure(BridgeErrorCode.InvalidRequest, `Not a domain: ${domain}`)
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

/** The keys a grant may be kept under (`folderSpellings`, `grantedDomain`). */
function normalizedKeys(key: SandboxGrantKey): SandboxGrantKey[] {
  switch (key.kind) {
    case SandboxGrantKind.Folder:
      return folderSpellings(key.path).map((path) => ({ kind: key.kind, path }))
    case SandboxGrantKind.Domain:
      return [{ kind: key.kind, domain: grantedDomain(key.domain) }]
  }
}

/**
 * Grants a folder or domain to a scope (`addSandboxGrant`: no duplicates, and a read-only folder granted read-write is
 * upgraded), then applies the scope's grants to the running sessions they cover: always, even when the scope already
 * had the grant, so granting again repairs a session that refused it before. Resolves with what changed and which
 * sessions have it, once they've answered (or, given `awaitTaskId`, once that task's has).
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a folder that's relative or
 * a pattern, or a value that isn't a domain.
 */
export async function grantSandboxAccess(
  { db, runner }: SandboxGrantsContext,
  { target, grant }: NewSandboxGrant,
  options?: SandboxApplyOptions,
): Promise<SandboxGrantOutcome> {
  requireTarget(db, target)
  const change = addSandboxGrant(db, { target, grant: normalizedGrant(grant) })
  return { change, sessions: await runner.applySandboxGrants(target, options) }
}

/**
 * Sets a scope's granted folder's access, wider or narrower (a read-write folder downgraded to read-only, say), then
 * applies the scope's grants to the running sessions they cover, changed or not. Resolves with what changed
 * (`Unchanged` when the scope has no such folder or it already has that access) and which sessions have it.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a folder that's relative or
 * a pattern.
 */
export async function changeSandboxFolderAccess(
  { db, runner }: SandboxGrantsContext,
  target: SandboxGrantTarget,
  path: string,
  access: FolderAccess,
  options?: SandboxApplyOptions,
): Promise<SandboxGrantOutcome> {
  requireTarget(db, target)
  const changes = folderSpellings(path).map((spelling) => setSandboxFolderAccess(db, target, spelling, access))
  const changed = changes.includes(SandboxGrantChange.Changed)
  return {
    change: changed ? SandboxGrantChange.Changed : SandboxGrantChange.Unchanged,
    sessions: await runner.applySandboxGrants(target, options),
  }
}

/**
 * Takes a folder or domain back from a scope, then applies the scope's grants to the running sessions they covered:
 * always, so taking it back again repairs a session that refused the change before. Resolves with whether the scope
 * had it and which sessions have lost it.
 *
 * @throws CommandFailure `not_found` for no such task or workspace, `invalid_request` for a folder that's relative or
 * a pattern, or a value that isn't a domain.
 */
export async function revokeSandboxGrant(
  { db, runner }: SandboxGrantsContext,
  target: SandboxGrantTarget,
  key: SandboxGrantKey,
  options?: SandboxApplyOptions,
): Promise<SandboxRevokeOutcome> {
  requireTarget(db, target)
  const removed = normalizedKeys(key).map((spelling) => removeSandboxGrant(db, target, spelling))
  return { removed: removed.includes(true), sessions: await runner.applySandboxGrants(target, options) }
}
