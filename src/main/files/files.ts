/**
 * The files of a task's workspace, for the Files tab: reading one for the viewer, the tabs open in it, opening one in
 * your editor, and the agent's `show_file`. A file is only ever reached inside the task's workspace root: every path is
 * resolved against the root's real path, and so is every symlink along it, so `..` or a symlink can't reach a file
 * outside it.
 */
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import { FileContentKind, type FileContent, type OpenFiles } from '../../shared/domain'
import {
  MAX_FILE_BYTES,
  MAX_FILE_LINES,
  withClosedFile,
  withOpenedFile,
  workspaceRelativePath,
} from '../../shared/files'
import { CommandFailure } from '../bridge/errors'
import { getOpenFiles, setOpenFiles } from '../db/repositories/open-files'
import { getTask } from '../db/repositories/tasks'
import { getWorkspace } from '../db/repositories/workspaces'
import type { TaskServiceContext } from '../tasks/service'

/** Opens a file in the app macOS opens its kind of file with: Electron's `shell.openPath`, which answers with an error message, or `''`. */
export type OpenPath = (path: string) => Promise<string>

/** What the Files tab's commands need: the database and events, and a way to open a file in your editor. */
export interface FilesContext extends TaskServiceContext {
  readonly openPath: OpenPath
}

/** Whether `path` is `root` or inside it. Both are absolute. */
function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot.split(sep)[0] !== '..')
}

function outside(path: string): CommandFailure {
  return new CommandFailure(BridgeErrorCode.OutsideWorkspace, `${path} is outside the workspace`)
}

/** Whether an error from the file system means there's nothing at the path. */
function isMissing(error: unknown): boolean {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The real path of the file at `path` (relative to the workspace root), with every symlink resolved; null when there's
 * nothing there (nor a workspace root). Throws a `CommandFailure` (`outside_workspace`) when the path, or a symlink on
 * it, leads outside the root.
 */
export async function resolveWorkspaceFile(rootPath: string, path: string): Promise<string | null> {
  let root: string
  try {
    root = await realpath(rootPath)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const candidate = resolve(root, path)
  if (!isInside(root, candidate)) throw outside(path)
  let real: string
  try {
    real = await realpath(candidate)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (!isInside(root, real)) throw outside(path)
  return real
}

/** `text` cut to at most `MAX_FILE_LINES` lines; null when it has no more than that. */
function firstLines(text: string): string | null {
  let end = -1
  for (let line = 0; line < MAX_FILE_LINES; line++) {
    end = text.indexOf('\n', end + 1)
    if (end === -1) return null
  }
  return end === text.length - 1 ? null : text.slice(0, end + 1)
}

/**
 * A file inside the workspace, as the viewer shows it: its text, cut to its first lines when it's larger than the
 * viewer shows (`MAX_FILE_BYTES`, `MAX_FILE_LINES`); binary when it has a NUL byte; missing when there's no file there.
 * Throws a `CommandFailure` (`outside_workspace`) for a path that leads outside the root.
 */
export async function readWorkspaceFile(rootPath: string, path: string): Promise<FileContent> {
  const real = await resolveWorkspaceFile(rootPath, path)
  if (real === null) return { kind: FileContentKind.Missing }
  // No following a symlink swapped in since the path was resolved.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { kind: FileContentKind.Missing }
    const { size } = info
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) return { kind: FileContentKind.Binary, size }
    let text = new TextDecoder().decode(bytes)
    let truncated = size > bytesRead
    // Cut short, the last line is likely partial (and may end mid-character): drop it, unless it's the only one.
    if (truncated && text.includes('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
    const lines = firstLines(text)
    if (lines !== null) {
      text = lines
      truncated = true
    }
    return { kind: FileContentKind.Text, text, truncated, size }
  } finally {
    await handle.close()
  }
}

/** The root of a task's workspace. Throws a `CommandFailure` (`not_found`) when there's no such task. */
function workspaceRoot(context: TaskServiceContext, taskId: string): string {
  const task = getTask(context.db, taskId)
  const workspace = task === undefined ? undefined : getWorkspace(context.db, task.workspaceId)
  if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
  return workspace.rootPath
}

/** `files.read`: a file of the task's workspace, for the viewer. */
export async function readTaskFile(context: TaskServiceContext, taskId: string, path: string): Promise<FileContent> {
  return readWorkspaceFile(workspaceRoot(context, taskId), path)
}

function changeOpenFiles(
  context: TaskServiceContext,
  taskId: string,
  change: (openFiles: OpenFiles) => OpenFiles,
): OpenFiles {
  workspaceRoot(context, taskId)
  const openFiles = change(getOpenFiles(context.db, taskId))
  setOpenFiles(context.db, openFiles)
  context.emit({ type: EventType.OpenFilesChanged, openFiles })
  return openFiles
}

/** `files.open`: opens a file in the task's Files tab and shows it. Broadcasts `openFiles.changed`. */
export function openTaskFile(context: TaskServiceContext, taskId: string, path: string): OpenFiles {
  return changeOpenFiles(context, taskId, (openFiles) => withOpenedFile(openFiles, path))
}

/** `files.close`: closes a file's tab in the task's Files tab. Broadcasts `openFiles.changed`. */
export function closeTaskFile(context: TaskServiceContext, taskId: string, path: string): OpenFiles {
  return changeOpenFiles(context, taskId, (openFiles) => withClosedFile(openFiles, path))
}

/** `files.openInEditor`: opens a file of the task's workspace in the app macOS opens its kind of file with. */
export async function openTaskFileInEditor(context: FilesContext, taskId: string, path: string): Promise<void> {
  const real = await resolveWorkspaceFile(workspaceRoot(context, taskId), path)
  if (real === null) throw new CommandFailure(BridgeErrorCode.NotFound, `No file at ${path}`)
  const failure = await context.openPath(real)
  if (failure !== '') throw new Error(`Couldn't open ${path}: ${failure}`)
}

/** `files.reveal`: shows a file of the task's workspace in Finder, selected in its folder. */
export async function revealTaskFile(
  context: TaskServiceContext,
  taskId: string,
  path: string,
  showItemInFolder: (path: string) => void,
): Promise<void> {
  const real = await resolveWorkspaceFile(workspaceRoot(context, taskId), path)
  if (real === null) throw new CommandFailure(BridgeErrorCode.NotFound, `No file at ${path}`)
  showItemInFolder(real)
}

/**
 * The agent's `show_file`: opens a file of the task's workspace in its Files tab, and asks the window to show it there,
 * at `line`. `path` is absolute, or relative to the workspace root. Answers with the path relative to the root. Throws
 * an `Error`, for the tool to tell the model, when the path isn't a file inside the workspace.
 */
export async function showTaskFile(
  context: TaskServiceContext,
  taskId: string,
  path: string,
  line: number | null,
): Promise<string> {
  const root = workspaceRoot(context, taskId)
  const relativePath = workspaceRelativePath(path, root)
  if (relativePath === null) throw new Error(`${path} is outside the workspace (${root}).`)
  const real = await resolveWorkspaceFile(root, relativePath)
  if (real === null || !(await stat(real)).isFile()) throw new Error(`There's no file at ${path}.`)
  openTaskFile(context, taskId, relativePath)
  context.emit({ type: EventType.FileShown, taskId, path: relativePath, line })
  return relativePath
}
