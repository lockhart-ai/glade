import { memo } from 'react'
import { ChildKind } from '../../../shared/todoHub'
import { CommitTile } from './CommitTile'
import { FileTile } from './FileTile'
import { LinkTile } from './LinkTile'
import { SubagentTile } from './SubagentTile'
import type { KindTileProps } from './Tile'
import { WatcherTile } from './WatcherTile'

export interface ChildTileProps extends KindTileProps {
  readonly kind: ChildKind
}

/**
 * One child of a todo, as its kind's tile. It's given only which child it is, and reads the child itself from the
 * store (`./childIndex`), so it renders again when its own child changes and at no other time: not when another
 * child does, nor when the list around it is ordered anew.
 */
export const ChildTile = memo(function ChildTile({ taskId, kind, childKey }: ChildTileProps): React.JSX.Element {
  switch (kind) {
    case ChildKind.File:
      return <FileTile taskId={taskId} childKey={childKey} />
    case ChildKind.Link:
      return <LinkTile taskId={taskId} childKey={childKey} />
    case ChildKind.Subagent:
      return <SubagentTile taskId={taskId} childKey={childKey} />
    case ChildKind.Watcher:
      return <WatcherTile taskId={taskId} childKey={childKey} />
    case ChildKind.Commit:
      return <CommitTile taskId={taskId} childKey={childKey} />
  }
})
