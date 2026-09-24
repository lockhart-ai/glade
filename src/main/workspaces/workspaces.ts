import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, type WorkspaceUserPatch } from '../../shared/bridge'
import { UiStateKey, type EpochMs, type UiStateEntry, type Workspace } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { getTask } from '../db/repositories/tasks'
import { getUiState, setUiState } from '../db/repositories/ui-state'
import {
  clearWorkspaceSelection,
  getWorkspaceSelection,
  setWorkspaceSelection,
} from '../db/repositories/workspace-selections'
import { createWorkspace, getWorkspace, getWorkspaceByRoot, updateWorkspace } from '../db/repositories/workspaces'
import { seedClaudeMd } from './starter-claude-md'

export interface WorkspaceCreation {
  readonly workspace: Workspace
  /** False when a workspace with that root already existed. */
  readonly created: boolean
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

/**
 * Adds a workspace rooted at `rootPath`, an absolute path to an existing directory, named after the folder. Answers
 * with the existing workspace when one already has that root. A new workspace's root gets the starter `CLAUDE.md` if it
 * has none; nothing else is written to it.
 *
 * @throws CommandFailure `invalid_root_path` when `rootPath` isn't an existing directory.
 */
export function createWorkspaceAt(db: Database, rootPath: string, now: EpochMs = Date.now()): WorkspaceCreation {
  // Drop a trailing slash and `.`/`..` segments, so the same folder always has the same root.
  const root = resolve(rootPath)
  if (!isDirectory(root)) throw new CommandFailure(BridgeErrorCode.InvalidRootPath, `${root} is not a folder`)
  const existing = getWorkspaceByRoot(db, root)
  if (existing !== undefined) return { workspace: existing, created: false }
  // Seed before storing, so a root Glade can't write to never becomes a workspace.
  seedClaudeMd(root)
  const workspace = createWorkspace(db, { name: basename(root) || root, rootPath: root }, now)
  return { workspace, created: true }
}

export interface WorkspaceOpening {
  readonly workspace: Workspace
  /** The task selected now that the workspace shows: the one last selected in it, or null for none. */
  readonly selectedTaskId: string | null
  /** The UI state values the opening changed, to broadcast. */
  readonly uiState: readonly UiStateEntry[]
}

/**
 * Opens a workspace: records it as last opened and makes it the window's workspace, selecting the task last selected
 * in it (none if it had none), so switching between workspaces restores each one's selection.
 *
 * @throws CommandFailure `not_found` when there's no such workspace.
 */
export function openWorkspace(db: Database, id: string, now: EpochMs = Date.now()): WorkspaceOpening {
  return db.transaction((): WorkspaceOpening => {
    if (getWorkspace(db, id) === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${id}`)
    const workspace = updateWorkspace(db, id, { lastOpenedAt: now })
    const uiState: UiStateEntry[] = [{ key: UiStateKey.ActiveWorkspaceId, value: id }]
    const current = getUiState(db, UiStateKey.SelectedTaskId) ?? ''
    const currentTask = getTask(db, current)
    // A task already selected in this workspace stays; otherwise the workspace's own selection comes back.
    const selected = currentTask?.workspaceId === id ? currentTask.id : (getWorkspaceSelection(db, id) ?? '')
    if (selected !== current) uiState.push({ key: UiStateKey.SelectedTaskId, value: selected })
    for (const entry of uiState) setUiState(db, entry)
    return { workspace, selectedTaskId: selected === '' ? null : selected, uiState }
  })()
}

/**
 * Renames a workspace or moves it to another root folder (Settings › Workspace), leaving everything on disk as it is.
 * The name is saved trimmed; the root is resolved like a new workspace's.
 *
 * @throws CommandFailure `not_found` when there's no such workspace, `invalid_request` for a blank name, and
 *   `invalid_root_path` when the root isn't an existing directory or is another workspace's root.
 */
export function changeWorkspace(db: Database, id: string, patch: WorkspaceUserPatch): Workspace {
  return db.transaction((): Workspace => {
    if (getWorkspace(db, id) === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${id}`)
    const name = patch.name?.trim()
    if (name === '') throw new CommandFailure(BridgeErrorCode.InvalidRequest, 'A workspace name cannot be blank')
    const rootPath = patch.rootPath === undefined ? undefined : resolve(patch.rootPath)
    if (rootPath !== undefined) {
      if (!isDirectory(rootPath)) {
        throw new CommandFailure(BridgeErrorCode.InvalidRootPath, `${rootPath} is not a folder`)
      }
      const other = getWorkspaceByRoot(db, rootPath)
      if (other !== undefined && other.id !== id) {
        throw new CommandFailure(BridgeErrorCode.InvalidRootPath, `${rootPath} is already the workspace ${other.name}`)
      }
    }
    return updateWorkspace(db, id, {
      ...(name === undefined ? {} : { name }),
      ...(rootPath === undefined ? {} : { rootPath }),
    })
  })()
}

/**
 * Keeps each workspace's selection as UI state is stored (`uiState.set`, or main opening a task itself): selecting a
 * task records it as its workspace's selection, and selecting none clears the shown workspace's.
 */
export function noteSelection(db: Database, entry: UiStateEntry): void {
  if (entry.key !== UiStateKey.SelectedTaskId) return
  if (entry.value === '') {
    const shown = getUiState(db, UiStateKey.ActiveWorkspaceId)
    if (shown !== undefined) clearWorkspaceSelection(db, shown)
    return
  }
  const task = getTask(db, entry.value)
  if (task !== undefined) setWorkspaceSelection(db, task.workspaceId, task.id)
}
