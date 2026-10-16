/**
 * What the Files tab shows, worked out from a task's tool log: the files the agent changed and the ones it only read,
 * relative to the workspace root, and what the viewer needs to know about each. The summary itself is shared with main,
 * which computes it over a task's whole history for the first load (#637): `src/shared/touchedFiles.ts`.
 */
import {
  FileTouch,
  fileOfCall,
  mergeTouched,
  NO_TOUCHED_FILES,
  touchedFiles,
  type TouchedFile,
  type TouchedFiles,
} from '../../shared/touchedFiles'
import { FileContentKind, type FileContent } from '../../shared/domain'

export { FileTouch, fileOfCall, mergeTouched, NO_TOUCHED_FILES, touchedFiles }
export type { TouchedFile, TouchedFiles }

/** How many files the agent touched. */
export function touchedCount({ changed, read }: TouchedFiles): number {
  return changed.length + read.length
}

/** How the agent last touched a file, and when; undefined when it hasn't. */
export function touchOfFile(
  { changed, read }: TouchedFiles,
  path: string,
): { touch: FileTouch; file: TouchedFile } | undefined {
  const change = changed.find((file) => file.path === path)
  if (change !== undefined) return { touch: FileTouch.Changed, file: change }
  const reading = read.find((file) => file.path === path)
  return reading === undefined ? undefined : { touch: FileTouch.Read, file: reading }
}

/** Whether the agent changed a file. */
export function isChanged({ changed }: TouchedFiles, path: string): boolean {
  return changed.some((file) => file.path === path)
}

/** Whether a file is Markdown, which the viewer can show as a preview too. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/** Whether a file is static HTML, which the viewer can show as a preview too (#614), in its own sandboxed view. */
export function isHtml(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** Whether two readings of a file are of the same contents: the viewer shows nothing again when they are (#646). */
export function sameFileContent(a: FileContent, b: FileContent): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case FileContentKind.Text:
      return b.kind === FileContentKind.Text && a.text === b.text && a.truncated === b.truncated
    case FileContentKind.Image:
      return b.kind === FileContentKind.Image && a.dataUrl === b.dataUrl
    case FileContentKind.Binary:
      return b.kind === FileContentKind.Binary && a.size === b.size
    case FileContentKind.Missing:
      return true
  }
}

/** A size in bytes, as the viewer's notices say it: "812 bytes", "48 KB", "2.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} byte${bytes === 1 ? '' : 's'}`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
