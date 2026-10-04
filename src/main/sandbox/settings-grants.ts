/**
 * The sandbox lists in Settings (P15-06, #451): the Glade-wide folders and domains (Settings › Agent) and a workspace's
 * (Settings › Workspace), listed, added to, changed and removed through the grants' store (`./grants`), which saves
 * each change, broadcasts it (`sandbox.grantsChanged`) and applies it to the running tasks it covers without
 * restarting them. Each call here answers with the scope's grants as they are once those tasks have the change.
 *
 * What Add… refuses, each with the reason Settings shows under its list:
 * - what the sandbox can't take (`grantedFolder`, `grantedDomain`): a folder that is the whole disk or has a glob
 *   character, a domain that isn't a bare host or `*.` and a host of two labels or more;
 * - **a duplicate:** a folder or domain the scope already has. A folder it has read-only, added read-write, is
 *   upgraded instead, as a card's grant would;
 * - **the workspace root, or a folder inside it,** added to that workspace: its agents can already use it, read-write,
 *   so a grant there would do nothing, or, read-only, look like a limit it isn't. The Glade-wide lists take such a
 *   folder: it's another workspace's agents it's for.
 *
 * A task's grants aren't Settings': the bridge refuses a task's scope before it gets here (`../bridge/requests`).
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import {
  SandboxGrantKind,
  SandboxGrantScope,
  SETTINGS_GRANT_REFUSALS,
  type FolderAccess,
  type Grant,
  type GrantKey,
  type SettingsGrantTarget,
} from '../../shared/sandbox'
import { CommandFailure } from '../bridge/errors'
import { SandboxGrantChange } from '../db/repositories/sandbox-grants'
import { getWorkspace } from '../db/repositories/workspaces'
import { canonicalKey, keyInside, pathKey } from '../permissions/canonical-path'
import {
  changeSandboxFolderAccess,
  grantedFolder,
  grantSandboxAccess,
  revokeSandboxGrant,
  scopeGrants,
  type SandboxGrantsContext,
} from './grants'

/** The root of the workspace a scope is, or null Glade-wide. @throws CommandFailure `not_found` for no such workspace. */
function rootOf(db: Database, target: SettingsGrantTarget): string | null {
  switch (target.scope) {
    case SandboxGrantScope.Glade:
      return null
    case SandboxGrantScope.Workspace: {
      const workspace = getWorkspace(db, target.workspaceId)
      if (workspace === undefined) {
        throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${target.workspaceId}`)
      }
      return workspace.rootPath
    }
  }
}

/** What two spellings of one folder share; a path that can't be resolved, as written (as `./grants` keeps it). */
function folderKey(path: string): string {
  return canonicalKey(path) ?? pathKey(path)
}

/**
 * Refuses a folder a workspace's agents can already use: its root, or a folder inside it.
 *
 * @throws CommandFailure `invalid_request`, and for a folder the sandbox can't take (`grantedFolder`).
 */
function requireOutsideRoot(root: string, path: string): void {
  const folder = folderKey(grantedFolder(path))
  const rootKey = folderKey(root)
  if (folder === rootKey) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, SETTINGS_GRANT_REFUSALS.workspaceRoot)
  }
  if (keyInside(folder, rootKey)) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, SETTINGS_GRANT_REFUSALS.insideWorkspaceRoot)
  }
}

/** The refusal for a folder or domain the scope already has. */
function duplicate(grant: Grant): CommandFailure {
  switch (grant.kind) {
    case SandboxGrantKind.Folder:
      return new CommandFailure(BridgeErrorCode.InvalidRequest, SETTINGS_GRANT_REFUSALS.duplicateFolder)
    case SandboxGrantKind.Domain:
      return new CommandFailure(BridgeErrorCode.InvalidRequest, SETTINGS_GRANT_REFUSALS.duplicateDomain)
  }
}

/**
 * The grants Settings lists for a scope: its folders and domains, in the order they were first granted.
 *
 * @throws CommandFailure `not_found` for no such workspace.
 */
export function listSettingsGrants(db: Database, target: SettingsGrantTarget): Grant[] {
  rootOf(db, target)
  return scopeGrants(db, target)
}

/**
 * Adds a folder or domain to a scope's list (Add…), and answers with the list once the running tasks it covers have
 * it.
 *
 * @throws CommandFailure `not_found` for no such workspace, and `invalid_request`, with the reason to show, for what
 * the sandbox can't take, a duplicate, and a workspace's own root or a folder inside it (see the module comment).
 */
export async function addSettingsGrant(
  context: SandboxGrantsContext,
  target: SettingsGrantTarget,
  grant: Grant,
): Promise<Grant[]> {
  const root = rootOf(context.db, target)
  if (root !== null && grant.kind === SandboxGrantKind.Folder) requireOutsideRoot(root, grant.path)
  const { change } = await grantSandboxAccess(context, { target, grant })
  if (change === SandboxGrantChange.Unchanged) throw duplicate(grant)
  return scopeGrants(context.db, target)
}

/**
 * Sets a listed folder's access (the select on its row), and answers with the list once the running tasks it covers
 * have the change. Nothing changes for a folder the scope doesn't have: removed since the list was drawn, say.
 *
 * @throws CommandFailure `not_found` for no such workspace, `invalid_request` for a folder the sandbox can't take.
 */
export async function setSettingsFolderAccess(
  context: SandboxGrantsContext,
  target: SettingsGrantTarget,
  path: string,
  access: FolderAccess,
): Promise<Grant[]> {
  rootOf(context.db, target)
  await changeSandboxFolderAccess(context, target, path, access)
  return scopeGrants(context.db, target)
}

/**
 * Removes a folder or domain from a scope's list (the × on its row), and answers with the list once the running tasks
 * it covered have lost it. Nothing changes for one the scope doesn't have.
 *
 * @throws CommandFailure `not_found` for no such workspace, `invalid_request` for a folder or domain the sandbox can't
 * take.
 */
export async function removeSettingsGrant(
  context: SandboxGrantsContext,
  target: SettingsGrantTarget,
  key: GrantKey,
): Promise<Grant[]> {
  rootOf(context.db, target)
  await revokeSandboxGrant(context, target, key)
  return scopeGrants(context.db, target)
}
