/**
 * Files attached to messages (#396): a file dropped onto the input bar or pasted from Finder is copied, byte for byte,
 * into the task's folder of them in its workspace, `.glade/attachments/<task id>/`, and the agent gets its path, never
 * its contents. The renderer only ever names the file by the path Electron gave it (`webUtils.getPathForFile`, in the
 * preload); everything that touches the disk happens here.
 *
 * - A file's name is kept, made unique in the folder (`sales.csv`, then `sales (2).csv`). A symlink is copied as the
 *   file it leads to; a folder, or anything larger than `MAX_ATTACHED_FILE_BYTES`, is refused, saying why.
 * - The folder is kept out of git without touching any file the workspace commits: when the workspace is in a git
 *   repository, `/.glade/attachments/` (from the repository's top) goes in the repository's own `.git/info/exclude`,
 *   once. That file is never committed or pushed, so nothing changes in `git status` or anyone else's checkout, as a
 *   line added to a committed `.gitignore` would. A workspace that isn't in a repository has nothing to keep it out of.
 * - The copies stay as long as the task does (a done task keeps them); deleting the task deletes its folder. A file
 *   taken off a draft before it was ever sent goes at once (`discardAttachedFile`).
 */
import { constants, closeSync, openSync, readSync, realpathSync, rmSync, fstatSync } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { BridgeErrorCode } from '../../shared/bridge'
import {
  ATTACHMENTS_FOLDER,
  AttachedFileKind,
  attachmentsFolderOf,
  dedupedName,
  formatFileSize,
  isAttachedFileName,
  isAttachedFileOf,
  MAX_ATTACHED_FILE_BYTES,
  type AttachedFile,
} from '../../shared/attachedFiles'
import { hasImageSignature, ImageMediaType, MAX_IMAGE_BYTES, type ImageData } from '../../shared/images'
import { CommandFailure } from '../bridge/errors'
import { isAttachedFileSent } from '../db/repositories/attached-files'
import { workspaceFilesRoot, workspaceRoot } from '../files/files'
import type { Git } from '../git/git'
import type { Logger } from '../logging/logger'
import type { TaskServiceContext } from '../tasks/service'

/** What attaching a file needs: the database, and git, to keep the attachments out of the workspace's repository. */
export interface AttachmentsContext extends TaskServiceContext {
  readonly git: Pick<Git, 'locate'>
  /** Where a failure to keep the folder out of git is noted; it doesn't stop the file attaching. */
  readonly log: Logger
}

/** How much of a copied file is looked at to tell text from anything else. */
export const KIND_HEAD_BYTES = 8 * 1024

/** The most copies of one name a folder can have before attaching another is refused. */
const MAX_COPIES = 1000

/** The kinds of image the Files tab shows as a picture, by extension. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/** The kinds of image the agent takes as an image content block, by extension. */
const AGENT_IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: ImageMediaType.Png,
  jpg: ImageMediaType.Jpeg,
  jpeg: ImageMediaType.Jpeg,
  gif: ImageMediaType.Gif,
  webp: ImageMediaType.Webp,
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** An error's `code`, as Node's file system errors carry it. */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

function refuse(message: string): CommandFailure {
  return new CommandFailure(BridgeErrorCode.InvalidRequest, message)
}

/**
 * What a copied file is, from its name and its first bytes (`KIND_HEAD_BYTES`): an image the Files tab shows, by its
 * extension; text, when its first bytes are UTF-8 with no NUL (as the Files tab tells text, `fileContentOf`); anything
 * else is binary.
 */
export function attachedFileKindOf(name: string, head: Uint8Array): AttachedFileKind {
  if (IMAGE_EXTENSIONS.has(extensionOf(name))) return AttachedFileKind.Image
  if (head.includes(0)) return AttachedFileKind.Binary
  try {
    // `stream` leaves a character cut off at the end of the head alone, rather than calling it invalid.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
    return AttachedFileKind.Text
  } catch {
    return AttachedFileKind.Binary
  }
}

/** The first bytes of a file (up to `KIND_HEAD_BYTES`). */
async function headOf(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const head = Buffer.alloc(KIND_HEAD_BYTES)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Whether `path` is `root` or inside it. Both are absolute and real. */
function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot.split(sep)[0] !== '..')
}

/**
 * Whether what's there of `path` (inside `root`, which is real) leads outside `root`: one of its folders is a link to
 * somewhere else, or a link to nothing at all. The agent can make such a link in its workspace (`ln -s ~ .glade`), and
 * everything here runs outside its sandbox. What isn't there yet leads nowhere.
 */
async function leadsOutside(root: string, path: string): Promise<boolean> {
  let current = root
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part)
    let real: string
    try {
      real = await realpath(current)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
      // Nothing there: the rest is still to be made. A link to nothing is there, and leads wherever it says.
      const dangling = await lstat(current).then(
        (info) => info.isSymbolicLink(),
        () => false,
      )
      return dangling
    }
    if (!isInside(root, real)) return true
  }
  return false
}

/** `leadsOutside`, without waiting: for the paths read and deleted as a message is sent or a task deleted. */
function leadsOutsideSync(root: string, path: string): boolean {
  try {
    return !isInside(realpathSync(root), realpathSync(path))
  } catch {
    // Not there: nothing to read or delete, wherever it would lead.
    return true
  }
}

/**
 * The task's folder of attached files, made if it isn't there yet. Throws a `CommandFailure` (`outside_workspace`)
 * when it leads outside the workspace (a `.glade` that's a symlink to elsewhere): checked before anything is made, so
 * no folder is ever left outside the workspace (#514), and again once it's there.
 */
async function attachmentsFolder(filesRoot: string, taskId: string): Promise<string> {
  // The workspace's own folder, made again if it's gone: it's the one folder that's always the workspace's.
  await mkdir(filesRoot, { recursive: true })
  const root = await realpath(filesRoot)
  const folder = join(root, attachmentsFolderOf(taskId))
  const outside = (): CommandFailure =>
    new CommandFailure(BridgeErrorCode.OutsideWorkspace, `${ATTACHMENTS_FOLDER} is outside the workspace`)
  if (await leadsOutside(root, folder)) throw outside()
  await mkdir(folder, { recursive: true })
  if (!isInside(root, await realpath(folder))) throw outside()
  return folder
}

/** Copies `source` into `folder` under the first of its deduplicated names nothing has yet, answering with that name. */
async function copyInto(source: string, folder: string, name: string): Promise<string> {
  const taken = new Set(await readdir(folder))
  for (let copy = 1; copy <= MAX_COPIES; copy += 1) {
    const candidate = dedupedName(name, copy)
    if (taken.has(candidate)) continue
    try {
      // Only if nothing has appeared there since: a file attached at the same moment keeps its own name.
      await copyFile(source, join(folder, candidate), constants.COPYFILE_EXCL)
      return candidate
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
    }
  }
  throw refuse(`${name} can’t be attached: there are too many files of that name already.`)
}

/** A gitignore pattern for a path, with its wildcards and backslashes escaped so it matches only that path. */
function literalPattern(path: string): string {
  return path.replace(/[\\*?[]/g, (character) => `\\${character}`)
}

/**
 * Keeps a workspace's attachments out of git: when the workspace is in a repository, adds `/<root>/.glade/attachments/`
 * (from the repository's top) to the repository's `.git/info/exclude`, unless it's there already. Never touches a file
 * the repository commits (see the module comment). Does nothing for a workspace in no repository.
 */
export async function excludeAttachments(git: Pick<Git, 'locate'>, filesRoot: string): Promise<boolean> {
  const repo = await git.locate(filesRoot)
  if (repo === null) return false
  const fromTop = relative(repo.worktreePath, await realpath(filesRoot))
    .split(sep)
    .join('/')
  const pattern = `/${literalPattern(fromTop === '' ? '' : `${fromTop}/`)}${ATTACHMENTS_FOLDER}/`
  const info = join(repo.commonDir, 'info')
  await mkdir(info, { recursive: true })
  // The agent can write in the repository's own folder, and this runs outside its sandbox: an `info` or an `exclude`
  // swapped for a link (`ln -sf ~/.zshenv .git/info/exclude`) would have these lines land in a file of yours (#514).
  if (!isInside(await realpath(repo.commonDir), await realpath(info))) {
    throw new Error(`${info} leads outside the repository`)
  }
  // `O_NOFOLLOW` refuses a link as the file itself (`ELOOP`); `O_APPEND` writes at its end, whatever was read.
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
  const handle = await open(join(info, 'exclude'), flags, 0o644)
  try {
    const current = await handle.readFile('utf8')
    if (current.split('\n').some((line) => line.trim() === pattern)) return false
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    await handle.appendFile(`${separator}# Files attached to messages in Glade\n${pattern}\n`)
    return true
  } finally {
    await handle.close()
  }
}

/**
 * `attachments.add`: copies the file at `sourcePath` (absolute, as Electron named a file dropped or pasted) into the
 * task's folder of attached files, and answers with the copy. Throws a `CommandFailure`: `not_found` for no such task,
 * `invalid_request`, saying why, for a path with nothing at it, a folder, something other than a file, or a file over
 * `MAX_ATTACHED_FILE_BYTES`.
 */
export async function attachFile(
  context: AttachmentsContext,
  taskId: string,
  sourcePath: string,
): Promise<AttachedFile> {
  const filesRoot = workspaceFilesRoot(workspaceRoot(context, taskId))
  const name = basename(sourcePath)
  if (!isAttachedFileName(name)) throw refuse(`${name} can’t be attached: its name is too long.`)
  // A symlink is followed: its target is what's copied, under the link's own name.
  const info = await stat(sourcePath).catch((error: unknown) => {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') throw refuse(`${name} isn’t there any more.`)
    throw error
  })
  if (info.isDirectory()) throw refuse(`${name} is a folder: only files can be attached for now.`)
  if (!info.isFile()) throw refuse(`${name} isn’t a file, so it can’t be attached.`)
  if (info.size > MAX_ATTACHED_FILE_BYTES) {
    throw refuse(
      `${name} is too large to attach (${formatFileSize(info.size)}): files can be up to ${formatFileSize(MAX_ATTACHED_FILE_BYTES)}.`,
    )
  }
  const folder = await attachmentsFolder(filesRoot, taskId)
  await excludeAttachments(context.git, filesRoot).catch((error: unknown) => {
    context.log.warn('couldn’t keep the attachments out of git', { taskId, error: String(error) })
  })
  const copied = await copyInto(sourcePath, folder, name)
  const copy = join(folder, copied)
  const size = (await stat(copy)).size
  return {
    name: copied,
    path: `${attachmentsFolderOf(taskId)}/${copied}`,
    size,
    kind: attachedFileKindOf(copied, await headOf(copy)),
  }
}

/**
 * `attachments.discard`: deletes the copy of a file taken off a draft before it was sent. A file a message has,
 * sent or queued, stays. Throws a `CommandFailure`: `not_found` for no such task, `invalid_request` for a path that
 * isn't one of the task's attached files.
 */
export async function discardAttachedFile(context: TaskServiceContext, taskId: string, path: string): Promise<void> {
  const filesRoot = workspaceFilesRoot(workspaceRoot(context, taskId))
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (!isAttachedFileOf(taskId, { name, path })) throw refuse(`${path} isn’t a file attached to the task`)
  if (isAttachedFileSent(context.db, taskId, path)) return
  // Never through a folder swapped for a link out of the workspace: the file to delete would be someone else's.
  if (leadsOutsideSync(filesRoot, dirname(join(filesRoot, path)))) return
  await unlink(join(filesRoot, path)).catch((error: unknown) => {
    if (codeOf(error) !== 'ENOENT') throw error
  })
}

/**
 * Deletes a task's folder of attached files, with everything in it, when the task is deleted. Nothing for a task that
 * never had any. A folder that can't be deleted is left, as the rest of the workspace is: the task is gone either way.
 */
export function deleteTaskAttachments(rootPath: string, taskId: string, log: Logger): void {
  if (!isAttachedFileName(taskId)) return
  const root = workspaceFilesRoot(rootPath)
  const folder = join(root, attachmentsFolderOf(taskId))
  // Never through a folder swapped for a link out of the workspace: what would be deleted there isn't the task's.
  if (leadsOutsideSync(root, dirname(folder))) return
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch (error) {
    log.warn('couldn’t delete the task’s attached files', { taskId, error: String(error) })
  }
}

/**
 * The attached files the agent also gets as images, in order: each PNG, JPEG, GIF or WebP whose copy is still there,
 * no larger than the API takes, and starts as its kind of image does. Read as the message is handed to the agent; a
 * file that can't be is left to its path line alone.
 */
export function attachedImagesOf(rootPath: string, files: readonly AttachedFile[]): ImageData[] {
  const images: ImageData[] = []
  for (const file of files) {
    const mediaType = AGENT_IMAGE_TYPES[extensionOf(file.name)]
    if (file.kind !== AttachedFileKind.Image || mediaType === undefined) continue
    const bytes = readImage(workspaceFilesRoot(rootPath), file.path)
    if (bytes !== null && hasImageSignature(mediaType, bytes)) {
      images.push({ mediaType, data: bytes.toString('base64') })
    }
  }
  return images
}

/**
 * A copied image's bytes, at `path` in the workspace at `root`; null when it's gone, isn't a file, is larger than the
 * API takes, or isn't in the workspace any more: the agent can swap the copy, or a folder above it, for a link to an
 * image elsewhere while its message waits in the queue, and this reads outside its sandbox (#514).
 */
function readImage(root: string, path: string): Buffer | null {
  const file = join(root, path)
  // No following a folder above it swapped for a link out of the workspace since it was copied.
  if (leadsOutsideSync(root, dirname(file))) return null
  let descriptor: number
  try {
    // Nor a symlink put in its own place.
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null
    const bytes = Buffer.alloc(info.size)
    const read = readSync(descriptor, bytes, 0, bytes.length, 0)
    return bytes.subarray(0, read)
  } finally {
    closeSync(descriptor)
  }
}
