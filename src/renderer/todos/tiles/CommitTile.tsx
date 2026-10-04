import { faCodeCommit } from '@fortawesome/free-solid-svg-icons'
import { useShallow } from 'zustand/react/shallow'
import { ChildKind } from '../../../shared/todoHub'
import { additionsLabel, deletionsLabel, shortHash } from '../../changes/changesModel'
import { useGladeStore } from '../../store/react'
import { findCommit } from './childIndex'
import { Tile, type KindTileProps } from './Tile'
import styles from './Tile.module.css'

/**
 * A commit's tile: its short hash, its subject, the lines it added and removed, and how long ago it was made. Opening
 * it in place to its branch and its files is #499.
 */
export function CommitTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const commit = useGladeStore(useShallow((state) => findCommit(state.commits[taskId], childKey)))
  if (commit === undefined) return null
  return (
    <Tile
      kind={ChildKind.Commit}
      name={commit.subject}
      lead={shortHash(commit.hash)}
      icon={faCodeCommit}
      state={
        <>
          <span className={styles.added}>{additionsLabel(commit.additions)}</span>{' '}
          <span className={styles.removed}>{deletionsLabel(commit.deletions)}</span>
        </>
      }
      at={commit.committedAt}
    />
  )
}
