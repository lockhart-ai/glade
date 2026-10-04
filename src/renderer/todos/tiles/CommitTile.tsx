import { faCodeCommit } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentsOf } from '../../agents/agentsModel'
import type { TaskCommit } from '../../../shared/domain'
import { ChildKind } from '../../../shared/todoHub'
import {
  additionsLabel,
  branchLabel,
  deletionsLabel,
  madeByTitle,
  MERGE_LABEL,
  shortHash,
} from '../../changes/changesModel'
import { CommitFileList, readCommitFiles, type LoadedFiles } from '../../changes/CommitFiles'
import { classNames } from '../../components/classNames'
import { useMenuCommands } from '../../context-menus'
import { useGladeStore } from '../../store/react'
import { findCommit } from './childIndex'
import { Tile, type KindTileProps } from './Tile'
import { FILES_CLASS, makerName, TileMeta, TileOpened, WELL_CLASS } from './TileParts'
import styles from './Tile.module.css'

interface OpenCommitProps {
  readonly taskId: string
  readonly commit: TaskCommit
  /** The subagent that made it; null for the task's own agent. */
  readonly by: string | null
  /** What reading its files has come to. */
  readonly files: LoadedFiles | undefined
}

/**
 * What a commit's tile opens to: its branch and the subagent that made it (`SubagentTag`), then the files it
 * changed (`CommitFileList`). The subagent's name goes to its tab in the Agents tab (`showAgent`, #537). A file
 * opens in the Files tab, read-only: as it is now, or as the commit left it when it's gone from its path. View only:
 * nothing here commits, pushes or reverts.
 */
function OpenCommit({ taskId, commit, by, files }: OpenCommitProps): React.JSX.Element {
  const showCommitFile = useGladeStore((state) => state.showCommitFile)
  const showAgent = useGladeStore((state) => state.showAgent)
  const agentId = commit.subagentToolUseId
  // A subagent the task's log hasn't got has no tab to go to.
  const hasTab = useGladeStore((state) => agentId !== null && agentsOf(state.toolEvents[taskId]).calls.has(agentId))
  const { run } = useMenuCommands()
  return (
    <>
      <TileMeta
        by={by}
        byTitle={madeByTitle}
        onOpenBy={
          agentId !== null && hasTab
            ? () => {
                showAgent(taskId, agentId)
              }
            : undefined
        }
      >
        {branchLabel(commit)}
      </TileMeta>
      <div className={classNames(WELL_CLASS, FILES_CLASS)}>
        <CommitFileList
          hash={shortHash(commit.hash)}
          files={files}
          onOpenFile={(path) => {
            run(() => showCommitFile(taskId, commit.id, path))
          }}
        />
      </div>
    </>
  )
}

/**
 * A commit's tile (#499): its short hash, its subject (`merge` after it for
 * a merge commit), the lines it added and removed, and how long ago it was made. Click it (or ↵ or Space on it) to
 * open it in place to its branch, the subagent that made it and its files, read from git the first time it opens and
 * kept while the tile shows; click again to close it.
 */
export function CommitTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const commit = useGladeStore(useShallow((state) => findCommit(state.commits[taskId], childKey)))
  const by = useGladeStore((state) =>
    makerName(state.toolEvents[taskId], findCommit(state.commits[taskId], childKey)?.subagentToolUseId ?? null),
  )
  const commitFiles = useGladeStore((state) => state.commitFiles)
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<LoadedFiles | undefined>(undefined)
  if (commit === undefined) return null
  const toggle = (): void => {
    setOpen(!open)
    // Read as it opens, and again if the last read failed.
    if (open || (files !== undefined && files.state !== 'failed')) return
    setFiles({ state: 'loading' })
    void readCommitFiles(() => commitFiles(taskId, commit.id)).then(setFiles)
  }
  return (
    <Tile
      kind={ChildKind.Commit}
      name={commit.subject}
      lead={shortHash(commit.hash)}
      tag={commit.merge ? MERGE_LABEL : null}
      icon={faCodeCommit}
      state={
        <>
          <span className={styles.added}>{additionsLabel(commit.additions)}</span>{' '}
          <span className={styles.removed}>{deletionsLabel(commit.deletions)}</span>
        </>
      }
      at={commit.committedAt}
      onOpen={toggle}
    >
      <TileOpened open={open}>
        <OpenCommit taskId={taskId} commit={commit} by={by} files={files} />
      </TileOpened>
    </Tile>
  )
}
