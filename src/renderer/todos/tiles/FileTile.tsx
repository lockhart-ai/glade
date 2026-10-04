import { useShallow } from 'zustand/react/shallow'
import { ArtifactKind } from '../../../shared/domain'
import { ChildKind, refKey } from '../../../shared/todoHub'
import { tileIcon } from '../../artifacts/artifactIcons'
import { artifactTime, fileTypeName } from '../../artifacts/artifactsModel'
import { useGladeStore } from '../../store/react'
import { findArtifact } from './childIndex'
import { Tile, type KindTileProps } from './Tile'

/**
 * A file artifact's tile: its type's icon, its title, its type and how long ago the file last changed. What the
 * Artifacts tab's row does besides (opening it, its thumbnail, Open, Reveal in folder and More) is #498.
 */
export function FileTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const ref = refKey({ kind: ChildKind.File, key: childKey })
  const artifact = useGladeStore(useShallow((state) => findArtifact(state.artifacts[taskId], ref)))
  if (artifact?.kind !== ArtifactKind.File) return null
  return (
    <Tile
      kind={ChildKind.File}
      name={artifact.title}
      icon={tileIcon(artifact.path)}
      tag={fileTypeName(artifact.path)}
      at={artifactTime(artifact)}
    />
  )
}
