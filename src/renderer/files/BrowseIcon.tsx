import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faFile, faFileCode, faFileLines, faFolder, faFolderOpen, faImage } from '@fortawesome/free-regular-svg-icons'
import { faFolder as faFolderFill, faFolderOpen as faFolderOpenFill } from '@fortawesome/free-solid-svg-icons'
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
 * The glyphs drawn here. Font Awesome's free sets have no braces, and a database, a padlock, a cube and a hash only as
 * solid shapes, which sit too heavy beside its outlined pages; these are outlines on a 24px grid, at the weight of its
 * regular set (docs/design/html/37-browse-files.html has the same shapes).
 */
type DrawnGlyph = FileGlyph.Config | FileGlyph.Database | FileGlyph.Lock | FileGlyph.Docker | FileGlyph.Stylesheet

/** The glyphs Font Awesome's regular set has. */
type SetGlyph = Exclude<FileGlyph, DrawnGlyph>

function drawing(glyph: DrawnGlyph): React.JSX.Element {
  switch (glyph) {
    case FileGlyph.Config:
      return (
        <>
          <path d="M9.5 3.5C7.3 3.5 6.5 4.6 6.5 6.4v2.7c0 1.6-.9 2.9-2.6 2.9 1.7 0 2.6 1.3 2.6 2.9v2.7c0 1.8.8 2.9 3 2.9" />
          <path d="M14.5 3.5c2.2 0 3 1.1 3 2.9v2.7c0 1.6.9 2.9 2.6 2.9-1.7 0-2.6 1.3-2.6 2.9v2.7c0 1.8-.8 2.9-3 2.9" />
        </>
      )
    case FileGlyph.Database:
      return (
        <>
          <ellipse cx="12" cy="6" rx="7.5" ry="3" />
          <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
          <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
        </>
      )
    case FileGlyph.Lock:
      return (
        <>
          <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
          <path d="M8 10.5v-3a4 4 0 0 1 8 0v3" />
        </>
      )
    case FileGlyph.Docker:
      return (
        <>
          <path d="M12 2.75 4 7v10l8 4.25L20 17V7z" />
          <path d="m4 7 8 4.25L20 7M12 11.25v10" />
        </>
      )
    case FileGlyph.Stylesheet:
      return <path d="M9.5 4 8 20M16 4l-1.5 16M4.5 9H20M4 15h15.5" />
  }
}

interface DrawnProps {
  readonly glyph: DrawnGlyph
}

/** One of the glyphs drawn here, in the current text colour. */
function Drawn({ glyph }: DrawnProps): React.JSX.Element {
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
      data-icon={glyph}
    >
      {drawing(glyph)}
    </svg>
  )
}

/** The Font Awesome icon of each glyph its regular set has. */
function setIcon(glyph: SetGlyph): IconDefinition {
  switch (glyph) {
    case FileGlyph.Code:
      return faFileCode
    case FileGlyph.Docs:
      return faFileLines
    case FileGlyph.Image:
      return faImage
    case FileGlyph.Dotfile:
    case FileGlyph.File:
      return faFile
  }
}

function glyphIcon(glyph: FileGlyph): React.JSX.Element {
  switch (glyph) {
    case FileGlyph.Config:
    case FileGlyph.Database:
    case FileGlyph.Lock:
    case FileGlyph.Docker:
    case FileGlyph.Stylesheet:
      return <Drawn glyph={glyph} />
    case FileGlyph.Code:
    case FileGlyph.Docs:
    case FileGlyph.Image:
    case FileGlyph.Dotfile:
    case FileGlyph.File:
      return <Icon icon={setIcon(glyph)} />
  }
}

export interface FileIconProps {
  /** The file's name, or its path: the icon goes by the name. */
  readonly path: string
}

/**
 * A file's icon in the Browse tab (#431): its kind's glyph, tinted by its family (`./fileKinds`). The pages and the
 * picture are Font Awesome's regular icons; the rest are drawn here, and the dotfile's is the plain page with a dot.
 */
export function FileIcon({ path }: FileIconProps): React.JSX.Element {
  const { glyph, family } = fileKind(path.slice(path.lastIndexOf('/') + 1))
  return (
    <span className={classNames(styles.icon, FAMILY_CLASS[family])} data-glyph={glyph} data-family={family}>
      {glyphIcon(glyph)}
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
