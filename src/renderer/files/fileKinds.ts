/**
 * What kind of file a name is, for the Browse tab's icons (#431): which glyph its row shows, and which family tints
 * it. Worked out from the name alone (a few special names, then the extension), without regard to case; a name it
 * doesn't know gets the plain file.
 */

/** The glyph on a file's row. */
export enum FileGlyph {
  /** Source code: a page with angle brackets. */
  Code = 'code',
  /** Prose: a page with lines. */
  Docs = 'docs',
  /** A stylesheet: a hash. */
  Stylesheet = 'stylesheet',
  /** Configuration and structured data: braces. */
  Config = 'config',
  /** A database, a query or a table of data: a cylinder. */
  Database = 'database',
  /** A picture. */
  Image = 'image',
  /** A lockfile: a padlock. */
  Lock = 'lock',
  /** A Dockerfile: a cube. */
  Docker = 'docker',
  /** A dotfile: a page with a dot. */
  Dotfile = 'dotfile',
  /** Anything else: a plain page. */
  File = 'file',
}

/** The family a file's icon is tinted by: code blue, images teal, data purple, config and docs grey. */
export enum FileFamily {
  Code = 'code',
  Image = 'image',
  Data = 'data',
  Config = 'config',
  Docs = 'docs',
}

/** A file's icon: its glyph, and the family that tints it. */
export interface FileKind {
  readonly glyph: FileGlyph
  readonly family: FileFamily
}

const CODE: FileKind = { glyph: FileGlyph.Code, family: FileFamily.Code }
const STYLESHEET: FileKind = { glyph: FileGlyph.Stylesheet, family: FileFamily.Code }
const CONFIG: FileKind = { glyph: FileGlyph.Config, family: FileFamily.Config }
const DATABASE: FileKind = { glyph: FileGlyph.Database, family: FileFamily.Data }
const IMAGE: FileKind = { glyph: FileGlyph.Image, family: FileFamily.Image }
const DOCS: FileKind = { glyph: FileGlyph.Docs, family: FileFamily.Docs }
const LOCK: FileKind = { glyph: FileGlyph.Lock, family: FileFamily.Config }
const DOCKER: FileKind = { glyph: FileGlyph.Docker, family: FileFamily.Config }
const DOTFILE: FileKind = { glyph: FileGlyph.Dotfile, family: FileFamily.Config }
const PLAIN: FileKind = { glyph: FileGlyph.File, family: FileFamily.Docs }

/** Each kind's extensions, without the dot, in lower case. */
const EXTENSIONS: readonly (readonly [FileKind, readonly string[]])[] = [
  [
    CODE,
    [
      ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift'],
      ...['c', 'h', 'cc', 'cpp', 'hpp', 'm', 'cs', 'php', 'lua', 'pl', 'r', 'scala', 'dart', 'ex', 'exs'],
      ...['sh', 'zsh', 'bash', 'fish', 'html', 'htm', 'xml', 'vue', 'svelte'],
    ],
  ],
  [STYLESHEET, ['css', 'scss', 'sass', 'less']],
  [CONFIG, ['json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'plist']],
  [DATABASE, ['sql', 'sqlite', 'sqlite3', 'db', 'csv', 'tsv', 'parquet']],
  [IMAGE, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic', 'tif', 'tiff']],
  [DOCS, ['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'pdf']],
  [LOCK, ['lock', 'lockb']],
]

const BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map(
  EXTENSIONS.flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind] as const)),
)

/** The lockfiles that don't end in `.lock`, in lower case. */
const LOCKFILES: ReadonlySet<string> = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'go.sum'])

/** The names without an extension that are prose, in lower case. */
const DOCS_NAMES: ReadonlySet<string> = new Set([
  'readme',
  'license',
  'licence',
  'changelog',
  'notice',
  'authors',
  'contributing',
])

/** Whether a name (in lower case) is a Dockerfile: `Dockerfile`, `Dockerfile.dev`, `api.dockerfile`, `Containerfile`. */
function isDockerfile(name: string): boolean {
  return (
    name === 'dockerfile' || name === 'containerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')
  )
}

/**
 * A file's icon, by its name: a lockfile, a Dockerfile and a dotfile (any name that starts with a dot) by their
 * names, then by extension, then the few prose names that have none; the plain file for anything else.
 */
export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase()
  if (LOCKFILES.has(lower)) return LOCK
  if (isDockerfile(lower)) return DOCKER
  if (lower.startsWith('.')) return DOTFILE
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return DOCS_NAMES.has(lower) ? DOCS : PLAIN
  return BY_EXTENSION.get(lower.slice(dot + 1)) ?? PLAIN
}
