/**
 * What an artifact's tile says about it: its file's type and icon, or what its link is (#407), and when it last
 * changed.
 */
import { linkDetail, recogniseLink } from '../../shared/artifactLinks'
import { ArtifactKind, type Artifact, type EpochMs, type FileArtifact } from '../../shared/domain'

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

/** Whether an artifact is a file the image viewer can open (PNG, JPEG, GIF, WebP or SVG), by its path. A link never is. */
export function isImageArtifact(artifact: Artifact): artifact is FileArtifact {
  return artifact.kind === ArtifactKind.File && fileTileKind(artifact.path) === FileTileKind.Image
}

/**
 * What an artifact's tile says of it after its title: a file's type (`Markdown`, `PNG`), or what a link is (`#412 ·
 * acme/api`, `API-123`, `example.com`).
 */
export function artifactTypeName(artifact: Artifact): string {
  switch (artifact.kind) {
    case ArtifactKind.File:
      return fileTypeName(artifact.path)
    case ArtifactKind.Link:
      return linkDetail(recogniseLink(artifact.url))
  }
}

/**
 * When an artifact last changed, as its todo orders and dates it: when its file last changed, as main last saw it (a
 * file that's gone keeps its last known time), or when it was declared, until main has looked. A link has no file:
 * when it was last declared or changed.
 */
export function artifactTime(artifact: Artifact): EpochMs {
  switch (artifact.kind) {
    case ArtifactKind.File:
      return artifact.modifiedAt ?? artifact.updatedAt
    case ArtifactKind.Link:
      return artifact.updatedAt
  }
}
