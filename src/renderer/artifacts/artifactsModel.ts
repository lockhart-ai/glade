/** What an artifact's card says about its file: "Markdown · 128 lines · 12m ago", from `docs/design/html/10-artifacts.html`. */
import { FileInfoKind, type EpochMs, type FileInfo } from '../../shared/domain'
import { formatAgo } from '../task-header/headerModel'

/** What a missing file's card says in place of its lines and age. */
export const MISSING = 'missing'

/** The kinds of file an artifact is likely to be, by extension (lowercase, without the dot). */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  md: 'Markdown',
  markdown: 'Markdown',
  mdx: 'MDX',
  txt: 'Text',
  text: 'Text',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  swift: 'Swift',
  sh: 'Shell',
  zsh: 'Shell',
  bash: 'Shell',
  yml: 'YAML',
  yaml: 'YAML',
  jpg: 'JPEG',
  jpeg: 'JPEG',
}

/**
 * The kind of file at `path`, from its extension: a name for the common ones (`Markdown`, `Text`), the extension in
 * capitals for others (`CSV`, `PDF`), and `File` when it has none.
 */
export function fileTypeName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  // A dot file (`.env`) has a name, not an extension.
  if (dot <= 0 || dot === name.length - 1) return 'File'
  const extension = name.slice(dot + 1).toLowerCase()
  return TYPE_NAMES[extension] ?? extension.toUpperCase()
}

const NUMBER = new Intl.NumberFormat('en-US')

/** A line count: `1 line`, `128 lines`, `1,240 lines`. */
export function formatLines(lines: number): string {
  return `${NUMBER.format(lines)} ${lines === 1 ? 'line' : 'lines'}`
}

/**
 * The card's line about its file: its type, then its lines (for a text file) and how long ago it changed, or that
 * it's missing. Only its type while its file hasn't been looked at yet (`info` undefined).
 */
export function describeFile(path: string, info: FileInfo | undefined, now: EpochMs): string {
  const parts = [fileTypeName(path)]
  if (info !== undefined) {
    switch (info.kind) {
      case FileInfoKind.Text:
        parts.push(formatLines(info.lines), formatAgo(info.modifiedAt, now))
        break
      case FileInfoKind.Other:
        parts.push(formatAgo(info.modifiedAt, now))
        break
      case FileInfoKind.Missing:
        parts.push(MISSING)
        break
    }
  }
  return parts.join(' · ')
}
