import { faFolder } from '@fortawesome/free-regular-svg-icons'
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useRef, useState } from 'react'
import type { FileArtifact } from '../../shared/domain'
import { useMenuCommands } from '../context-menus'
import { ImageViewer, type ImageViewerHeader } from '../images/ImageViewer'
import { ImageSourceKind, workspaceImageSource, type ImageViewerSource } from '../images/imageSources'
import { useGladeStore } from '../store/react'

/** Which image artifact the image viewer is open on, among a list's. */
export interface ViewedImage {
  /** The path of the one showing; null while the viewer is shut. */
  readonly path: string | null
  /** What takes the focus back once it closes: what it was opened from. */
  readonly returnFocus: React.RefObject<HTMLElement | null>
  /** Opens the viewer on an image artifact, from `trigger`. */
  readonly open: (path: string, trigger: HTMLElement) => void
  /** Steps it to another of the list's images. */
  readonly view: (path: string) => void
  readonly close: () => void
}

/**
 * The image viewer's place among `paths`, the image artifacts a list shows, in its order. Once the one it shows is no
 * longer among them (removed, or its file changed kind), it closes.
 */
export function useViewedImage(paths: readonly string[]): ViewedImage {
  const [viewing, setViewing] = useState<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const gone = viewing !== null && !paths.includes(viewing)
  if (gone) setViewing(null)

  const open = useCallback((path: string, trigger: HTMLElement) => {
    returnFocus.current = trigger
    setViewing(path)
  }, [])
  const close = useCallback(() => {
    setViewing(null)
  }, [])
  return { path: gone ? null : viewing, returnFocus, open, view: setViewing, close }
}

export interface ArtifactImageViewerProps {
  readonly taskId: string
  /** The image artifacts it steps through, in the list's order. */
  readonly images: readonly FileArtifact[]
  readonly viewed: ViewedImage
}

/**
 * The image viewer over a list's image artifacts (#372): one todo's tiles in the Todos tab (P16, #498). ← and → step through `images` and no further; over each, its artifact's title,
 * Open in Files (which closes the viewer) and Reveal in Finder. Nothing while it's shut.
 */
export function ArtifactImageViewer({ taskId, images, viewed }: ArtifactImageViewerProps): React.JSX.Element | null {
  const showFile = useGladeStore((state) => state.showFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const { run } = useMenuCommands()
  const { path: viewing, returnFocus, view, close } = viewed

  const header = useCallback(
    (source: ImageViewerSource): ImageViewerHeader | undefined => {
      if (source.kind !== ImageSourceKind.Workspace) return undefined
      const { taskId: sourceTaskId, path } = source
      return {
        title: source.title,
        actions: [
          {
            icon: faArrowUpRightFromSquare,
            label: 'Open in Files',
            onClick: () => {
              close()
              run(() => showFile(sourceTaskId, path))
            },
          },
          {
            icon: faFolder,
            label: 'Reveal in Finder',
            onClick: () => {
              run(() => revealFile(sourceTaskId, path))
            },
          },
        ],
      }
    },
    [close, run, showFile, revealFile],
  )

  const index = viewing === null ? -1 : images.findIndex((artifact) => artifact.path === viewing)
  if (index === -1) return null
  return (
    <ImageViewer
      images={images.map((artifact) => workspaceImageSource(taskId, artifact.path, artifact.title))}
      index={index}
      onIndexChange={(next) => {
        const artifact = images[next]
        if (artifact !== undefined) view(artifact.path)
      }}
      onClose={close}
      returnFocus={returnFocus}
      header={header}
    />
  )
}
