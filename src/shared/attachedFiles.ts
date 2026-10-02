/**
 * Files attached to a message (#396): dropped onto the input bar or pasted from Finder, each copied into the task's
 * workspace, at `.glade/attachments/<task id>/<name>`, so the agent reads the exact bytes with its own tools. The agent
 * never gets a file's contents inlined: it gets one line per file, at the end of the message, saying where it is
 * (`docs/model-surface.md`). Pure, so main and the renderer share it; paths are POSIX, as Glade runs on macOS.
 */

/** What a file attached to a message holds, as Glade looked at it when it was copied: what clicking its chip does. */
export enum AttachedFileKind {
  /** Text: the Files tab shows it. */
  Text = 'text',
  /** An image the Files tab shows as a picture (PNG, JPEG, GIF, WebP or SVG). */
  Image = 'image',
  /** Anything else (a PDF, a spreadsheet, an archive): the Files tab can't show it, so its chip reveals it in Finder. */
  Binary = 'binary',
}

/** A file attached to a message: its copy in the workspace, which the agent gets the path of. */
export interface AttachedFile {
  /** The copy's file name, as the chip shows it: the original's, made unique in its folder (`sales (2).csv`). */
  readonly name: string
  /** The copy's path, relative to the workspace root: `.glade/attachments/<task id>/<name>`. */
  readonly path: string
  /** Its size in bytes, when it was copied. */
  readonly size: number
  readonly kind: AttachedFileKind
}

/** The largest file that can be attached, in bytes: 200 MB. */
export const MAX_ATTACHED_FILE_BYTES = 200 * 1024 * 1024

/** The longest file name an attached file can have, in characters (macOS allows 255). */
export const MAX_ATTACHED_FILE_NAME_LENGTH = 255

/** Where every task's attached files are, relative to the workspace root. */
export const ATTACHMENTS_FOLDER = '.glade/attachments'

/** Where a task's attached files are, relative to the workspace root. */
export function attachmentsFolderOf(taskId: string): string {
  return `${ATTACHMENTS_FOLDER}/${taskId}`
}

/** Whether a name can be an attached file's: one path segment, not `.` or `..`, with no NUL, and not too long. */
export function isAttachedFileName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\0') &&
    name.length <= MAX_ATTACHED_FILE_NAME_LENGTH
  )
}

/** Whether an attached file is one of the task's: named as a file may be, at its place in the task's folder. */
export function isAttachedFileOf(taskId: string, file: Pick<AttachedFile, 'name' | 'path'>): boolean {
  return isAttachedFileName(file.name) && file.path === `${attachmentsFolderOf(taskId)}/${file.name}`
}

/**
 * The name the `copy`th file of a name gets in a folder that may have it already: the name itself first, then
 * `sales (2).csv`, `sales (3).csv`, …, before its extension (after the whole name when it has none, or is a dot file
 * like `.env`).
 */
export function dedupedName(name: string, copy: number): string {
  if (copy <= 1) return name
  const dot = name.lastIndexOf('.')
  const suffix = ` (${String(copy)})`
  return dot <= 0 ? `${name}${suffix}` : `${name.slice(0, dot)}${suffix}${name.slice(dot)}`
}

const UNITS = ['KB', 'MB', 'GB'] as const

/**
 * A size in bytes as the chip and the agent read it: `512 bytes`, `48 KB`, `1.2 MB`. One decimal under 10 of a unit
 * (dropped when it's `.0`), whole numbers from there.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${String(bytes)} bytes`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value))
  // Rounding can carry a value up to the next unit's size (1023.9 KB is "1024 KB"): that's fine to say as it is.
  return `${shown} ${UNITS[unit] ?? 'GB'}`
}

/**
 * The line the agent gets for a file attached to a message: its name, size, and path relative to the workspace root,
 * with the absolute path too, since the agent may have changed folder by the time it reads it.
 */
export function attachedFileLine(file: AttachedFile, rootPath: string): string {
  const root = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  return `Attached file: ${file.name} (${formatFileSize(file.size)}) at ${file.path} (absolute path: ${root}/${file.path})`
}

/**
 * A message's text as the agent gets it with its attached files: one line per file, in order, at the end, after a
 * blank line; just the lines when the text is blank. The contents are never inlined.
 */
export function withAttachedFiles(text: string, files: readonly AttachedFile[], rootPath: string): string {
  if (files.length === 0) return text
  const lines = files.map((file) => attachedFileLine(file, rootPath)).join('\n')
  return text.trim() === '' ? lines : `${text}\n\n${lines}`
}
