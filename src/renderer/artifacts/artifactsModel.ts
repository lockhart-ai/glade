/** What an artifact's row says about it (#307, `docs/design/html/10-artifacts.html`): its file's type, and its age. */
import { ArtifactDateGroup, type Artifact, type EpochMs } from '../../shared/domain'
import { clockTime } from '../chat/chatModel'
import { formatDay } from '../task-header/headerModel'
import { formatRelativeTime } from '../task-list/relativeTime'
import { dateGroupOf, groupByDate, type DateGrouped } from './dateGroups'

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

/** A file's extension, lowercase and without the dot; empty when it has none (or is a dot file, like `.env`). */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * The kind of file at `path`, from its extension: a name for the common ones (`Markdown`, `Text`), the extension in
 * capitals for others (`CSV`, `PNG`), and `File` when it has none.
 */
export function fileTypeName(path: string): string {
  const extension = extensionOf(path)
  if (extension === '') return 'File'
  return TYPE_NAMES[extension] ?? extension.toUpperCase()
}

/** Which icon a file's type tile shows, before (or instead of) a thumbnail. */
export enum FileTileKind {
  /** An image: PNG, JPEG, GIF, WebP or SVG. */
  Image = 'image',
  /** Code or a config file. */
  Code = 'code',
  /** Prose: Markdown, text, and anything else. */
  Text = 'text',
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'swift',
  'sh',
  'zsh',
  'bash',
  'yml',
  'yaml',
  'json',
  'toml',
  'css',
  'html',
  'sql',
])

/** The icon on a file's type tile, by its extension. */
export function fileTileKind(path: string): FileTileKind {
  const extension = extensionOf(path)
  if (IMAGE_EXTENSIONS.has(extension)) return FileTileKind.Image
  if (CODE_EXTENSIONS.has(extension)) return FileTileKind.Code
  return FileTileKind.Text
}

/**
 * How long ago an artifact was declared, as its row shows it: `8m` or `2h` today, the time (`15:02`) yesterday, and the
 * day (`Sep 21`) before that.
 */
export function formatArtifactAge(at: EpochMs, now: EpochMs): string {
  const group = dateGroupOf(at, now)
  switch (group) {
    case ArtifactDateGroup.Today:
      return formatRelativeTime(at, now)
    case ArtifactDateGroup.Yesterday:
      return clockTime(at)
    case ArtifactDateGroup.ThisWeek:
    case ArtifactDateGroup.LastWeek:
    case ArtifactDateGroup.ThisMonth:
    case ArtifactDateGroup.Older:
      return formatDay(at)
  }
}

/**
 * When an artifact last changed, as the tab orders and dates it: when its file last changed, as main last saw it (a
 * file that's gone keeps its last known time), or when it was declared, until main has looked.
 */
export function artifactTime(artifact: Pick<Artifact, 'modifiedAt' | 'updatedAt'>): EpochMs {
  return artifact.modifiedAt ?? artifact.updatedAt
}

/**
 * Newest first: the one whose file changed last; at the same time, the one declared last, then first declared last,
 * then by path, so the order never wavers.
 */
function newestFirst(a: Artifact, b: Artifact): number {
  return (
    artifactTime(b) - artifactTime(a) ||
    b.updatedAt - a.updatedAt ||
    b.addedAt - a.addedAt ||
    a.path.localeCompare(b.path)
  )
}

/** A task's artifacts in their date groups, newest first, by when each one's file last changed. */
export function groupArtifacts(artifacts: readonly Artifact[], now: EpochMs): DateGrouped<Artifact>[] {
  return groupByDate([...artifacts].sort(newestFirst), artifactTime, now)
}
