import { isBridgeError } from '../../shared/bridge'
import type { CommitFile, CommitFiles } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { additionsLabel, deletionsLabel, filePathLabel, moreFilesLabel, statusLetter, statusName } from './changesModel'
import styles from './CommitFiles.module.css'

/** What reading a commit's files has come to. */
export type LoadedFiles =
  | { readonly state: 'loading' }
  | { readonly state: 'loaded'; readonly files: CommitFiles }
  | { readonly state: 'failed'; readonly message: string }

/** Reads a commit's files with `read`, and answers with what that came to: loaded, or failed and why. Never rejects. */
export async function readCommitFiles(read: () => Promise<CommitFiles>): Promise<LoadedFiles> {
  try {
    return { state: 'loaded', files: await read() }
  } catch (error: unknown) {
    return { state: 'failed', message: isBridgeError(error) ? error.message : String(error) }
  }
}

export interface StatsProps {
  readonly additions: number | null
  readonly deletions: number | null
}

/** `+12 −3`, or `binary` for a file with no lines to count. */
export function Stats({ additions, deletions }: StatsProps): React.JSX.Element {
  if (additions === null || deletions === null) return <span className={styles.binary}>binary</span>
  return (
    <span className={styles.stats}>
      <span className={styles.added}>{additionsLabel(additions)}</span>
      <span className={styles.deleted}>{deletionsLabel(deletions)}</span>
    </span>
  )
}

interface FileRowProps {
  readonly file: CommitFile
  readonly onOpen: () => void
}

/** One file a commit changed: its status letter, path and lines. Click it to open it in Files. */
function FileRow({ file, onOpen }: FileRowProps): React.JSX.Element {
  const path = filePathLabel(file)
  return (
    <li>
      <button type="button" className={styles.file} onClick={onOpen} title={path} data-status={file.status}>
        <span className={classNames(styles.letter, styles[file.status])} aria-label={statusName(file.status)}>
          {statusLetter(file.status)}
        </span>
        <span className={styles.path}>{path}</span>
        <Stats additions={file.additions} deletions={file.deletions} />
      </button>
    </li>
  )
}

export interface CommitFileListProps {
  /** The commit's short hash, which names its list of files. */
  readonly hash: string
  /** What reading its files has come to; undefined before it's asked for, which reads as still loading. */
  readonly files: LoadedFiles | undefined
  /** Opens one of its files in Files, by its path. */
  readonly onOpenFile: (path: string) => void
}

/**
 * The files a commit changed, once they're read: a row each, which opens the file in Files, then how many more there
 * are past the cap. Until then it says it's reading them, or why it can't. Under a commit in the Changes tab, and in a
 * commit's opened tile in the todo hub (P16).
 */
export function CommitFileList({ hash, files, onOpenFile }: CommitFileListProps): React.JSX.Element {
  if (files === undefined || files.state === 'loading') return <p className={styles.note}>Reading its files…</p>
  if (files.state === 'failed') {
    return (
      <p className={classNames(styles.note, styles.failed)} role="status">
        Its files can’t be read: {files.message}
      </p>
    )
  }
  const more = moreFilesLabel(files.files.files.length, files.files.total)
  return (
    <>
      <ul className={styles.fileList} aria-label={`Files in ${hash}`}>
        {files.files.files.map((file) => (
          <FileRow
            key={`${file.oldPath ?? ''}\0${file.path}`}
            file={file}
            onOpen={() => {
              onOpenFile(file.path)
            }}
          />
        ))}
      </ul>
      {more !== null && <p className={styles.note}>{more}</p>}
    </>
  )
}
