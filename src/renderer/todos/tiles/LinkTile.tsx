import { useShallow } from 'zustand/react/shallow'
import { linkLabel, recogniseLink } from '../../../shared/artifactLinks'
import { ArtifactKind } from '../../../shared/domain'
import { ChildKind, childRefKey } from '../../../shared/todoHub'
import { linkIcon } from '../../artifacts/artifactIcons'
import { artifactTime } from '../../artifacts/artifactsModel'
import { useGladeStore } from '../../store/react'
import { findArtifact } from './childIndex'
import { Tile, type KindTileProps } from './Tile'

/**
 * A link artifact's tile: the icon of what it is (a pull request, an issue, a ticket, a page), its title, then its
 * number, its ticket's key or its domain, from its address alone, and how long ago it last changed. Opening it, and
 * Open link, Copy link and More, are #498.
 */
export function LinkTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const ref = childRefKey({ kind: ChildKind.Link, key: childKey })
  const artifact = useGladeStore(useShallow((state) => findArtifact(state.artifacts[taskId], ref)))
  if (artifact?.kind !== ArtifactKind.Link) return null
  return (
    <Tile
      kind={ChildKind.Link}
      name={artifact.title}
      icon={linkIcon(artifact.url)}
      tag={linkLabel(recogniseLink(artifact.url))}
      at={artifactTime(artifact)}
    />
  )
}
