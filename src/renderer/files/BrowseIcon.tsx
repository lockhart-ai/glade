import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faFile, faFileCode, faFileLines, faFolder, faFolderOpen, faImage } from '@fortawesome/free-regular-svg-icons'
import {
  faCube,
  faDatabase,
  faFolder as faFolderFill,
  faFolderOpen as faFolderOpenFill,
  faHashtag,
  faLock,
} from '@fortawesome/free-solid-svg-icons'
import { Icon } from '../components'
import { classNames } from '../components/classNames'
import { FileFamily, FileGlyph, fileKind } from './fileKinds'
import styles from './BrowseIcon.module.css'

const FAMILY_CLASS: Readonly<Record<FileFamily, string | undefined>> = {
  [FileFamily.Code]: styles.code,
  [FileFamily.Image]: styles.image,
  [FileFamily.Data]: styles.data,
  [FileFamily.Config]: styles.config,
  [FileFamily.Docs]: styles.docs,
}

/**
 * Braces, for configuration: Font Awesome's free sets have none, so this one is drawn here, on the 24px grid and at the
 * weight of its regular set.
 */
function Braces(): React.JSX.Element {
  return (
    <svg
      className={styles.drawn}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-icon="braces"
    >
      <path d="M9.5 3.5C7.3 3.5 6.5 4.6 6.5 6.4v2.7c0 1.6-.9 2.9-2.6 2.9 1.7 0 2.6 1.3 2.6 2.9v2.7c0 1.8.8 2.9 3 2.9" />
      <path d="M14.5 3.5c2.2 0 3 1.1 3 2.9v2.7c0 1.6.9 2.9 2.6 2.9-1.7 0-2.6 1.3-2.6 2.9v2.7c0 1.8-.8 2.9-3 2.9" />
    </svg>
  )
}

/**
 * The glyphs Font Awesome's free sets have only as solid shapes: drawn a little smaller, so they weigh no more than the
 * outlined pages beside them.
 */
const SOLID_GLYPHS: ReadonlySet<FileGlyph> = new Set([
  FileGlyph.Stylesheet,
  FileGlyph.Database,
  FileGlyph.Lock,
  FileGlyph.Docker,
])

/** The Font Awesome icon of each glyph that has one. */
function glyphIcon(glyph: Exclude<FileGlyph, FileGlyph.Config>): IconDefinition {
  switch (glyph) {
    case FileGlyph.Code:
      return faFileCode
    case FileGlyph.Docs:
      return faFileLines
    case FileGlyph.Stylesheet:
      return faHashtag
    case FileGlyph.Database:
      return faDatabase
    case FileGlyph.Image:
      return faImage
    case FileGlyph.Lock:
      return faLock
    case FileGlyph.Docker:
      return faCube
    case FileGlyph.Dotfile:
    case FileGlyph.File:
      return faFile
  }
}

export interface FileIconProps {
  /** The file's name, or its path: the icon goes by the name. */
  readonly path: string
}

/**
 * A file's icon in the Browse tab (#431): its kind's glyph, tinted by its family (`./fileKinds`). The glyphs are Font
 * Awesome's, but the braces (drawn here) and the dotfile's, which is its plain page with a dot on it.
 */
export function FileIcon({ path }: FileIconProps): React.JSX.Element {
  const { glyph, family } = fileKind(path.slice(path.lastIndexOf('/') + 1))
  return (
    <span
      className={classNames(styles.icon, FAMILY_CLASS[family], SOLID_GLYPHS.has(glyph) && styles.solid)}
      data-glyph={glyph}
      data-family={family}
    >
      {glyph === FileGlyph.Config ? <Braces /> : <Icon icon={glyphIcon(glyph)} />}
      {glyph === FileGlyph.Dotfile && <span className={styles.dot} />}
    </span>
  )
}

export interface FolderIconProps {
  readonly open: boolean
}

/** A folder's icon in the Browse tab: closed or open, its outline over a soft fill of the same shape. */
export function FolderIcon({ open }: FolderIconProps): React.JSX.Element {
  return (
    <span className={classNames(styles.icon, styles.folder)}>
      <Icon icon={open ? faFolderOpenFill : faFolderFill} className={styles.fill} />
      <Icon icon={open ? faFolderOpen : faFolder} />
    </span>
  )
}
