/**
 * The files of a task's workspace, for the Files and Artifacts tabs: reading one for the viewer and saving one from the
 * editor, the tabs open in it, opening one in your editor, an artifact's file's thumbnail, copying and revealing it,
 * and the agent's `show_file`. A file is only ever reached inside the task's workspace root: every path is resolved
 * against the root's real path, and so is every symlink along it, so `..` or a symlink can't reach a file outside it.
 */
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import {
  FileContentKind,
  FileThumbnailKind,
  type FileContent,
  type FileThumbnail,
  type ImageFileContent,
  type OpenFiles,
} from '../../shared/domain'
import {
  MAX_FILE_BYTES,
  MAX_FILE_LINES,
  MAX_SAVE_BYTES,
  withClosedFile,
  withOpenedFile,
  workspaceRelativePath,
} from '../../shared/files'
import { CommandFailure } from '../bridge/errors'
import { getOpenFiles, setOpenFiles } from '../db/repositories/open-files'
import { getTask } from '../db/repositories/tasks'
import { getWorkspace } from '../db/repositories/workspaces'
import type { TaskServiceContext } from '../tasks/service'
import {
  IMAGE_HEAD_BYTES,
  imageMediaTypeOf,
  isThumbnailImage,
  MAX_THUMBNAIL_SOURCE_BYTES,
  startsAsImage,
  type Thumbnails,
} from '../artifacts/thumbnails'

/** Opens a file in the app macOS opens its kind of file with: Electron's `shell.openPath`, which answers with an error message, or `''`. */
export type OpenPath = (path: string) => Promise<string>

/** Shows a file in Finder, selected: Electron's `shell.showItemInFolder`. */
export type RevealPath = (path: string) => void

/** Puts text on the clipboard: Electron's `clipboard.writeText`. */
export type WriteClipboard = (text: string) => Promise<void>

/**
 * What the files commands need: the database and events, and the desktop: opening a file in your editor, showing one
 * in Finder and the clipboard.
 */
export interface FilesContext extends TaskServiceContext {
  readonly openPath: OpenPath
  readonly revealPath: RevealPath
  readonly writeClipboard: WriteClipboard
}

/** The most an artifact's Copy contents puts on the clipboard, in bytes. A larger file can't be copied. */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024

/**
 * The largest image the Files tab and the image viewer show whole, in bytes: read in full and sent to the renderer as
 * a base64 `data:` URL, so it stays well under what an IPC message comfortably carries. A larger image (or an artifact
 * whose thumbnail pipeline made one, `MAX_THUMBNAIL_SOURCE_BYTES`) shows the binary notice instead, with Open in editor.
 */
export const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024

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
 * The folders of sample files that made-up workspace roots stand for, by the made-up root. Only the test modes' seeds
 * set any (`applySeed`), so a capture shows sample data at an invented root (`~/code/docs`) rather than wherever the
 * fixture's files are on the machine that makes it. Empty in the app.
 */
const rootStandIns = new Map<string, string>()

/**
 * Has the workspace root `shown` (made up, as the sample data shows it) read its files from the folder `files`. For the
 * test modes' seeds only.
 */
export function standInForWorkspaceRoot(shown: string, files: string): void {
  rootStandIns.set(shown, files)
}

/** Where a workspace root's files are: the root itself, or the folder a made-up one stands for. */
export function workspaceFilesRoot(rootPath: string): string {
  return rootStandIns.get(rootPath) ?? rootPath
}

/**
 * The real path of the file at `path` (relative to the workspace root), with every symlink resolved; null when there's
 * nothing there (nor a workspace root). Throws a `CommandFailure` (`outside_workspace`) when the path, or a symlink on
 * it, leads outside the root.
 */
export async function resolveWorkspaceFile(rootPath: string, path: string): Promise<string | null> {
  let root: string
  try {
    root = await realpath(workspaceFilesRoot(rootPath))
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
 * A file named as one of the kinds a thumbnail is made of (`isThumbnailImage`), read whole and checked against its
 * kind's signature, as `data:` URL; null when it isn't really that kind of image (a mis-named file), so the caller
 * falls back to reading it as text or binary.
 */
async function readImageFile(handle: FileHandle, path: string, size: number): Promise<ImageFileContent | null> {
  const mediaType = imageMediaTypeOf(path)
  if (mediaType === undefined) return null
  const buffer = Buffer.alloc(size)
  const { bytesRead } = await handle.read(buffer, 0, size, 0)
  const bytes = buffer.subarray(0, bytesRead)
  if (!startsAsImage(path, bytes.subarray(0, Math.min(bytesRead, IMAGE_HEAD_BYTES)))) return null
  return {
    kind: FileContentKind.Image,
    mediaType,
    dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`,
    size,
  }
}

/**
 * A file inside the workspace, as the viewer shows it: an image (PNG, JPEG, GIF, WebP or SVG) up to `MAX_IMAGE_FILE_BYTES`
 * shows whole, as a `data:` URL, never inlined as markup even for SVG; text, cut to its first lines when it's larger
 * than the viewer shows (`MAX_FILE_BYTES`, `MAX_FILE_LINES`); binary when it has a NUL byte, or is a recognized image
 * too large to show, with the notice's "Open in editor"; missing when there's no file there. Throws a `CommandFailure`
 * (`outside_workspace`) for a path that leads outside the root.
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
    if (isThumbnailImage(path)) {
      // Too large to read whole and send as a data URL: the notice, not a truncated (invalid) image.
      if (size > MAX_IMAGE_FILE_BYTES) return { kind: FileContentKind.Binary, size }
      const image = await readImageFile(handle, path, size)
      if (image !== null) return image
    }
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return fileContentOf(buffer.subarray(0, bytesRead), size)
  } finally {
    await handle.close()
  }
}

/**
 * A file as the viewer shows it, from its first bytes (at most `MAX_FILE_BYTES`) and its whole size: its text, cut to
 * its first lines when it's larger than the viewer shows; binary when it has a NUL byte.
 */
export function fileContentOf(bytes: Buffer, size: number): FileContent {
  if (bytes.includes(0)) return { kind: FileContentKind.Binary, size }
  let text = new TextDecoder().decode(bytes)
  let truncated = size > bytes.length
  // Cut short, the last line is likely partial (and may end mid-character): drop it, unless it's the only one.
  if (truncated && text.includes('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1)
  const lines = firstLines(text)
  if (lines !== null) {
    text = lines
    truncated = true
  }
  return { kind: FileContentKind.Text, text, truncated, size }
}

/** The root of a task's workspace. Throws a `CommandFailure` (`not_found`) when there's no such task. */
export function workspaceRoot(context: TaskServiceContext, taskId: string): string {
  const task = getTask(context.db, taskId)
  const workspace = task === undefined ? undefined : getWorkspace(context.db, task.workspaceId)
  if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
  return workspace.rootPath
}

/** `files.read`: a file of the task's workspace, for the viewer. */
export async function readTaskFile(context: TaskServiceContext, taskId: string, path: string): Promise<FileContent> {
  return readWorkspaceFile(workspaceRoot(context, taskId), path)
}

/** What an error from the file system means for a save, as the failure the editor shows. */
export function saveFailure(path: string, error: unknown): unknown {
  if (isMissing(error)) return new CommandFailure(BridgeErrorCode.NotFound, `${path}'s folder isn't there`)
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  // Something appeared at the path since it was looked at: a symlink (never followed) or a folder.
  if (code === 'EEXIST' || code === 'ELOOP' || code === 'EISDIR') {
    return new CommandFailure(BridgeErrorCode.InvalidRequest, `${path} isn't a file`)
  }
  // Said plainly, without the file's whole path.
  if (code === 'EACCES' || code === 'EPERM') return new Error(`you don't have permission to write ${path}`)
  if (code === 'EROFS') return new Error(`${path} is on a read-only disk`)
  return error
}

/**
 * The absolute path to make a file of the workspace at, when there's nothing at `path` now (the file went): its folder,
 * resolved as any path is, so it's inside the root. Throws a `CommandFailure`: `not_found` when the folder isn't there,
 * `invalid_request` when something is at the path after all (a symlink that leads nowhere), `outside_workspace` when
 * the folder, or a symlink on the way to it, leads outside the root.
 */
async function newWorkspaceFile(rootPath: string, path: string): Promise<string> {
  const slash = path.lastIndexOf('/')
  const folder = await resolveWorkspaceFile(rootPath, slash === -1 ? '' : path.slice(0, slash))
  if (folder === null) throw new CommandFailure(BridgeErrorCode.NotFound, `${path}'s folder isn't there`)
  const target = join(folder, path.slice(slash + 1))
  // Anything there can only be a symlink that leads nowhere (its path resolved to nothing). Any other trouble looking is
  // left to opening it, which makes it only if nothing is there.
  const there = await lstat(target).then(
    () => true,
    () => false,
  )
  if (there) throw new CommandFailure(BridgeErrorCode.InvalidRequest, `${path} is a link to nothing`)
  return target
}

/**
 * Opens a file of the workspace to write over it, or makes it again when it's gone: only ever inside the root. The path
 * is resolved as for reading, and the file opened without following a symlink swapped in since, or, when it's made
 * again, only if nothing has appeared at its path meanwhile.
 */
async function openForSaving(rootPath: string, path: string): Promise<FileHandle> {
  const real = await resolveWorkspaceFile(rootPath, path)
  if (real === null) {
    const target = await newWorkspaceFile(rootPath, path)
    return open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW)
  }
  // Never a folder, a pipe or a device: only a file is written.
  if (!(await lstat(real)).isFile()) throw new CommandFailure(BridgeErrorCode.InvalidRequest, `${path} isn't a file`)
  return open(real, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW)
}

/**
 * Saves a file of the workspace: writes `text` over it in place (keeping its permissions and any hard links), or makes
 * it again when it's gone (`openForSaving`). Throws a `CommandFailure`: `outside_workspace` for a path, or a symlink on
 * it, leading outside the root; `not_found` when its folder isn't there; `invalid_request` for text larger than
 * `MAX_SAVE_BYTES`, or something other than a file at the path. A file it may not write says so plainly.
 */
export async function writeWorkspaceFile(rootPath: string, path: string, text: string): Promise<void> {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > MAX_SAVE_BYTES) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, `${path} is too large to save`)
  }
  let handle: FileHandle
  try {
    handle = await openForSaving(rootPath, path)
  } catch (error) {
    throw saveFailure(path, error)
  }
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
}

/** `files.write`: saves a file of the task's workspace from the editor. */
export async function writeTaskFile(
  context: TaskServiceContext,
  taskId: string,
  path: string,
  text: string,
): Promise<void> {
  await writeWorkspaceFile(workspaceRoot(context, taskId), path, text)
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

/** `files.browse`: shows the task's Browse tab, with no file tab showing. Broadcasts `openFiles.changed`. */
export function browseTaskFiles(context: TaskServiceContext, taskId: string): OpenFiles {
  return changeOpenFiles(context, taskId, (openFiles) => ({ ...openFiles, activePath: null }))
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

/**
 * A file of a task's workspace that a Glade tool names: `path` is absolute, or relative to the workspace root. Answers
 * with the path relative to the root. Throws an `Error`, for the tool to tell the model, when the path isn't a file
 * inside the workspace.
 */
export async function toolFilePath(context: TaskServiceContext, taskId: string, path: string): Promise<string> {
  return workspaceFilePath(workspaceRoot(context, taskId), path)
}

/**
 * A file of the workspace at `root`: `path` is absolute, or relative to the root. Answers with the path relative to the
 * root. Throws an `Error` saying why when the path isn't a file inside the workspace.
 */
export async function workspaceFilePath(root: string, path: string): Promise<string> {
  const relativePath = workspaceRelativePath(path, root)
  if (relativePath === null) throw new Error(`${path} is outside the workspace (${root}).`)
  const real = await resolveWorkspaceFile(root, relativePath)
  if (real === null || !(await stat(real)).isFile()) throw new Error(`There's no file at ${path}.`)
  return relativePath
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
  const relativePath = await toolFilePath(context, taskId, path)
  openTaskFile(context, taskId, relativePath)
  context.emit({ type: EventType.FileShown, taskId, path: relativePath, line })
  return relativePath
}

/**
 * Opens a regular file of a task's workspace for reading and hands it to `read`; `read` gets null when there's no file
 * there. Throws a `CommandFailure` for a path outside the workspace, or a task that isn't there.
 */
async function withTaskFile<T>(
  context: TaskServiceContext,
  taskId: string,
  path: string,
  read: (file: { handle: FileHandle; real: string; info: Stats } | null) => Promise<T>,
): Promise<T> {
  const real = await resolveWorkspaceFile(workspaceRoot(context, taskId), path)
  if (real === null) return read(null)
  // No following a symlink swapped in since the path was resolved.
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    return await read(info.isFile() ? { handle, real, info } : null)
  } finally {
    await handle.close()
  }
}

/**
 * `files.thumbnail`: a file of the task's workspace as its artifact's row shows it: a thumbnail of an image
 * (`../artifacts/thumbnails`), none for any other file (or an image too large, one that doesn't start as its kind of
 * image does, or one no thumbnail can be made of), or missing. The file is looked at and let go before its thumbnail
 * is made.
 */
export async function thumbnailOfTaskFile(
  context: TaskServiceContext,
  thumbnails: Thumbnails,
  taskId: string,
  path: string,
): Promise<FileThumbnail> {
  const looked = await withTaskFile(context, taskId, path, async (file) => {
    if (file === null) return null
    const source = { realPath: file.real, size: file.info.size, modifiedMs: file.info.mtimeMs }
    if (!isThumbnailImage(path) || source.size > MAX_THUMBNAIL_SOURCE_BYTES) return { source, image: false }
    const head = Buffer.alloc(Math.min(source.size, IMAGE_HEAD_BYTES))
    const { bytesRead } = await file.handle.read(head, 0, head.length, 0)
    return { source, image: startsAsImage(path, head.subarray(0, bytesRead)) }
  })
  if (looked === null) return { kind: FileThumbnailKind.Missing }
  if (!looked.image) return { kind: FileThumbnailKind.None }
  const dataUrl = await thumbnails.thumbnailOf(looked.source)
  return dataUrl === null ? { kind: FileThumbnailKind.None } : { kind: FileThumbnailKind.Image, dataUrl }
}

/** `files.copy`: puts a text file's contents on the clipboard. */
export async function copyTaskFile(context: FilesContext, taskId: string, path: string): Promise<void> {
  const text = await withTaskFile(context, taskId, path, async (file) => {
    if (file === null) throw new CommandFailure(BridgeErrorCode.NotFound, `No file at ${path}`)
    if (file.info.size > MAX_ARTIFACT_BYTES) {
      throw new CommandFailure(BridgeErrorCode.InvalidRequest, `${path} is too large to copy`)
    }
    const bytes = await file.handle.readFile()
    if (bytes.includes(0)) throw new CommandFailure(BridgeErrorCode.InvalidRequest, `${path} isn't text`)
    return new TextDecoder().decode(bytes)
  })
  await context.writeClipboard(text)
}

/** `files.reveal`: shows a file of the task's workspace in Finder, selected. */
export async function revealTaskFile(context: FilesContext, taskId: string, path: string): Promise<void> {
  const real = await withTaskFile(context, taskId, path, (file) => {
    if (file === null) throw new CommandFailure(BridgeErrorCode.NotFound, `No file at ${path}`)
    return Promise.resolve(file.real)
  })
  context.revealPath(real)
}
