import { useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArtifactKind, type FileArtifact } from '../../../shared/domain'
import { ChildKind, refKey } from '../../../shared/todoHub'
import { FileActions } from '../../artifacts/ArtifactActions'
import { useFileArtifact } from '../../artifacts/artifactHooks'
import { tileIcon } from '../../artifacts/artifactIcons'
import { ArtifactThumb } from '../../artifacts/ArtifactThumb'
import { useGladeStore } from '../../store/react'
import { useArtifactTileHost, useTileMenuOpen } from './ArtifactTiles'
import { findArtifact } from './childIndex'
import { Tile, type KindTileProps } from './Tile'
import styles from './Tile.module.css'

interface FileArtifactTileProps {
  readonly artifact: FileArtifact
  /** Which child it is, as one string (`refKey`): what its context menu is opened for. */
  readonly childRef: string
}

/** The tile of a file the task has: `FileTile`, once its artifact is found. */
function FileArtifactTile({ artifact, childRef }: FileArtifactTileProps): React.JSX.Element {
  const { taskId, path, title } = artifact
  const host = useArtifactTileHost()
  const selected = useGladeStore((state) => state.openFiles[taskId]?.activePath === path)
  // How its file looks, and what Open and Reveal do: one with its row in the Artifacts tab.
  const file = useFileArtifact(artifact)
  const tile = useRef<HTMLDivElement>(null)
  const menuOpen = useTileMenuOpen(childRef)
  const { menuTargetProps } = host
  const menuTarget = useMemo(() => menuTargetProps(childRef), [menuTargetProps, childRef])
  const { missing } = file

  const open = (): void => {
    // An image opens in the viewer, over this todo's images; the tile takes the focus back once it closes.
    if (file.isImage && tile.current !== null) host.openImage(path, tile.current)
    else file.showInFiles()
  }

  return (
    <Tile
      ref={tile}
      kind={ChildKind.File}
      name={title}
      icon={tileIcon(path)}
      // An image's tile keeps the thumbnail's frame from the start, so it doesn't grow as its thumbnail arrives.
      media={
        file.isImage ? (
          <ArtifactThumb
            image={file.image}
            icon={tileIcon(path)}
            onLoad={file.onThumbnailLoad}
            onError={file.onThumbnailError}
          />
        ) : undefined
      }
      tag={file.typeLabel}
      tagTitle={path}
      at={file.time}
      selected={selected}
      muted={missing}
      busy={file.busy}
      menuTarget={menuTarget}
      actionsPinned={menuOpen}
      onOpen={missing ? undefined : open}
      actions={
        <FileActions
          missing={missing}
          buttonClassName={styles.action}
          onOpen={open}
          onReveal={file.reveal}
          onMore={(button) => {
            host.openMenu(childRef, button)
          }}
        />
      }
    />
  )
}

/**
 * A file artifact's tile, which does what its row in the Artifacts tab does (#498), with the row's own pieces: its
 * type's icon (an image's thumbnail, larger, in its place), its title, its type and how long ago the file last changed.
 * Clicking it, or ↵ or Space while it has the focus, opens the file in the Files tab, or the image viewer for an image,
 * which steps only through this todo's images. Under the pointer or with the focus, its age gives way to three icon
 * buttons: Open, Reveal in folder and More, its context menu, which a right-click and ⇧F10 open too. A file that's gone
 * shows faded, as missing, and can't be opened or revealed; the file the Files tab shows is outlined (#307).
 */
export function FileTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const ref = refKey({ kind: ChildKind.File, key: childKey })
  const artifact = useGladeStore(useShallow((state) => findArtifact(state.artifacts[taskId], ref)))
  if (artifact?.kind !== ArtifactKind.File) return null
  return <FileArtifactTile artifact={artifact} childRef={ref} />
}
