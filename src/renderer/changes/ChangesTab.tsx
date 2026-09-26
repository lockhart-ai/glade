import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState } from 'react'
import { isBridgeError } from '../../shared/bridge'
import type { CommitFile, CommitFiles, EpochMs, TaskCommit, ToolEvent } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Collapse, Icon, IconSize } from '../components'
import { useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'
import { useNow } from '../task-list/useNow'
import {
  additionsLabel,
  commitMeta,
  deletionsLabel,
  filePathLabel,
  madeBy,
  moreFilesLabel,
  shortHash,
  statusLetter,
  statusName,
} from './changesModel'
import styles from './ChangesTab.module.css'

/** What reading a commit's files has come to. */
type LoadedFiles =
  | { readonly state: 'loading' }
  | { readonly state: 'loaded'; readonly files: CommitFiles }
  | { readonly state: 'failed'; readonly message: string }

/** `+12 −3`, or `binary` for a file with no lines to count. */
function Stats({ additions, deletions }: { additions: number | null; deletions: number | null }): React.JSX.Element {
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

interface CommitRowProps {
  readonly commit: TaskCommit
  readonly now: EpochMs
  /** The subagent that made it; null for the task's own agent. */
  readonly by: string | null
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly files: LoadedFiles | undefined
  readonly onOpenFile: (path: string) => void
}

/**
 * One commit: its short hash, message, and lines; under them its branch, when, and the subagent that made it. Click it
 * to open its files below it; click again to close them.
 */
function CommitRow({ commit, now, by, expanded, onToggle, files, onOpenFile }: CommitRowProps): React.JSX.Element {
  const hash = shortHash(commit.hash)
  return (
    <div
      role="group"
      aria-label={commit.subject}
      className={classNames(styles.row, expanded && styles.expanded)}
      data-hash={commit.hash}
    >
      <button type="button" className={styles.header} aria-expanded={expanded} onClick={onToggle}>
        <span className={styles.titleLine}>
          <span className={styles.chevron}>
            <Icon icon={expanded ? faChevronDown : faChevronRight} size={IconSize.Small} />
          </span>
          <span className={styles.hash}>{hash}</span>
          <span className={styles.subject} title={commit.subject}>
            {commit.subject}
          </span>
          <Stats additions={commit.additions} deletions={commit.deletions} />
        </span>
        <span className={styles.meta}>
          <span className={styles.metaText}>{commitMeta(commit, now)}</span>
          {by !== null && (
            <span className={styles.subagent} title={`Made by the subagent “${by}”`}>
              {by}
            </span>
          )}
        </span>
      </button>
      <Collapse open={expanded}>
        <div className={styles.files}>
          {files === undefined || files.state === 'loading' ? (
            <p className={styles.note}>Reading its files…</p>
          ) : files.state === 'failed' ? (
            <p className={classNames(styles.note, styles.failed)} role="status">
              Its files can’t be read: {files.message}
            </p>
          ) : (
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
              {moreFilesLabel(files.files.files.length, files.files.total) !== null && (
                <p className={styles.note}>{moreFilesLabel(files.files.files.length, files.files.total)}</p>
              )}
            </>
          )}
        </div>
      </Collapse>
    </div>
  )
}

export interface ChangesTabProps {
  readonly taskId: string
  /** The task's commits, newest first. */
  readonly commits: readonly TaskCommit[]
  /** The task's tool log, which says which subagent made a commit. */
  readonly events: readonly ToolEvent[]
}

/**
 * The Changes tab (docs/design/html/24-changes.html): the commits the task's agent and its subagents made, newest
 * first. Glade only watches git here: there's no committing, pushing or reverting. A commit opens to the files it
 * changed (read from git as it opens, and kept while the tab shows the task); a file opens in Files, as it is now, or
 * as the commit left it when it's gone from its path. Without commits, the tab says the task has made none yet, or that
 * the workspace isn't a git repository.
 */
export function ChangesTab({ taskId, commits, events }: ChangesTabProps): React.JSX.Element {
  const now = useNow()
  const commitFiles = useGladeStore((state) => state.commitFiles)
  const showCommitFile = useGladeStore((state) => state.showCommitFile)
  const inRepository = useGladeStore((state) => state.inRepository)
  const { run } = useMenuCommands()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [files, setFiles] = useState<Readonly<Record<string, LoadedFiles>>>({})
  const [repository, setRepository] = useState<boolean | null>(null)
  const none = commits.length === 0

  useEffect(() => {
    if (!none) return
    let current = true
    inRepository(taskId).then(
      (answer) => {
        if (current) setRepository(answer)
      },
      () => {
        // Can't tell: say what's true either way.
        if (current) setRepository(true)
      },
    )
    return () => {
      current = false
    }
  }, [inRepository, taskId, none])

  if (none) {
    return repository === false ? (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>This workspace isn’t a git repository.</p>
        <p className={styles.emptyDetail}>Commits the agent makes in a repository inside it show here.</p>
      </div>
    ) : (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>No commits in this task yet.</p>
      </div>
    )
  }

  const load = (id: string): void => {
    setFiles((loaded) => ({ ...loaded, [id]: { state: 'loading' } }))
    commitFiles(taskId, id).then(
      (list) => {
        setFiles((loaded) => ({ ...loaded, [id]: { state: 'loaded', files: list } }))
      },
      (error: unknown) => {
        const message = isBridgeError(error) ? error.message : String(error)
        setFiles((loaded) => ({ ...loaded, [id]: { state: 'failed', message } }))
      },
    )
  }

  const toggle = (id: string): void => {
    const opening = !expanded.has(id)
    setExpanded((open) => {
      const next = new Set(open)
      if (!next.delete(id)) next.add(id)
      return next
    })
    const state = files[id]?.state
    if (opening && (state === undefined || state === 'failed')) load(id)
  }

  return (
    <div className={styles.scroller}>
      {commits.map((commit) => (
        <CommitRow
          key={commit.id}
          commit={commit}
          now={now}
          by={madeBy(commit, events)}
          expanded={expanded.has(commit.id)}
          onToggle={() => {
            toggle(commit.id)
          }}
          files={files[commit.id]}
          onOpenFile={(path) => {
            run(() => showCommitFile(taskId, commit.id, path))
          }}
        />
      ))}
    </div>
  )
}
