import { faXmark } from '@fortawesome/free-solid-svg-icons'
import type { AttachedFile } from '../../shared/attachedFiles'
import { Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import { fileChipDetail, fileIcon, opensInFiles } from './fileIcons'
import styles from './FileChip.module.css'

/** What clicking the chip of a file in the input bar does: the copy isn't sent yet, so it's only shown in Finder. */
export const REVEAL_TITLE = 'Reveal in Finder'
/** What clicking the chip of a sent file that the Files tab shows does. */
export const OPEN_TITLE = 'Open in Files'

interface ChipContentProps {
  readonly file: AttachedFile
}

/** A chip's insides: the tile with its type's icon, then its name over its type and size. */
function ChipContent({ file }: ChipContentProps): React.JSX.Element {
  return (
    <>
      <span className={styles.tile}>
        <Icon icon={fileIcon(file)} size={IconSize.Large} />
      </span>
      <span className={styles.text}>
        <span className={styles.name}>{file.name}</span>
        <span className={styles.detail}>{fileChipDetail(file)}</span>
      </span>
    </>
  )
}

export interface InputFileChipProps {
  readonly file: AttachedFile
  /** Shows the copy in Finder. */
  readonly onReveal: () => void
  /** Takes the file off the message. */
  readonly onRemove: () => void
}

/** A file attached to the message being written: a click reveals its copy in Finder, and ✕ takes it off. */
export function InputFileChip({ file, onReveal, onRemove }: InputFileChipProps): React.JSX.Element {
  return (
    <li className={styles.slot}>
      <button
        type="button"
        className={classNames(styles.chip, styles.input)}
        aria-label={`${file.name}, ${fileChipDetail(file)}`}
        title={REVEAL_TITLE}
        onClick={onReveal}
      >
        <ChipContent file={file} />
      </button>
      <button
        type="button"
        className={styles.remove}
        aria-label={`Remove ${file.name}`}
        title="Remove file"
        onClick={onRemove}
      >
        <Icon icon={faXmark} size={IconSize.Small} />
      </button>
    </li>
  )
}

export interface MessageFileChipProps {
  readonly file: AttachedFile
  /** Opens it: in the Files tab when it shows the file's kind, else in Finder (`opensInFiles`). */
  readonly onOpen: () => void
}

/** A file attached to a message in the chat: a click opens it in the Files tab, or reveals it in Finder. */
export function MessageFileChip({ file, onOpen }: MessageFileChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={classNames(styles.chip, styles.message)}
      aria-label={`${file.name}, ${fileChipDetail(file)}`}
      title={opensInFiles(file) ? OPEN_TITLE : REVEAL_TITLE}
      onClick={onOpen}
    >
      <ChipContent file={file} />
    </button>
  )
}

export interface QueuedFileChipProps {
  readonly file: AttachedFile
}

/** A queued message's file, small in its row: its type's icon and its name. */
export function QueuedFileChip({ file }: QueuedFileChipProps): React.JSX.Element {
  return (
    <span className={styles.queued} title={file.name}>
      <Icon icon={fileIcon(file)} size={IconSize.Small} />
      <span className={styles.queuedName}>{file.name}</span>
    </span>
  )
}
