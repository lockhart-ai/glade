import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArtifactKind } from '../../../shared/domain'
import { ChildKind, refKey, type Child } from '../../../shared/todoHub'
import { useArtifactMenu } from '../../artifacts/artifactHooks'
import { ArtifactImageViewer, useViewedImage, type ViewedImage } from '../../artifacts/ArtifactImageViewer'
import { fileTileKind, FileTileKind } from '../../artifacts/artifactsModel'
import { ContextMenu, useContextMenu, type ContextMenuTargetProps } from '../../context-menus'
import { useGladeStore } from '../../store/react'
import { findArtifact } from './childIndex'

/**
 * What one todo's list of tiles keeps for its file and link tiles, so each tile doesn't keep its own: the one context
 * menu, and the image viewer over the todo's images. Every function is the same for as long as the list is there, so a
 * tile that takes them never renders again because of them.
 */
export interface ArtifactTileHost {
  /** What makes a tile open its artifact's context menu, on a right-click or ⇧F10, by its child as one string (`refKey`). */
  readonly menuTargetProps: (ref: string) => ContextMenuTargetProps
  /** Opens that menu below the tile's More button. */
  readonly openMenu: (ref: string, button: HTMLElement) => void
  /** Opens the image viewer on an image file of this todo, from its tile, which takes the focus back once it closes. */
  readonly openImage: (path: string, tile: HTMLElement) => void
  /** Calls `listener` whenever the menu opens for another tile, or closes. Answers with what stops it. */
  readonly watchMenu: (listener: () => void) => () => void
  /** The child the menu is open for (`refKey`); undefined while it's closed. */
  readonly menuOpenFor: () => string | undefined
}

/**
 * Which tile a list's menu is open for, told to the tiles that ask (`useTileMenuOpen`) rather than handed down as a
 * prop or a context value, so a menu opening or closing renders the one tile it's for and no other.
 */
class MenuWatch {
  /** The child the menu is open for (`refKey`); undefined while it's closed. */
  openFor: string | undefined = undefined
  private readonly listeners = new Set<() => void>()

  watch(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  tell(openFor: string | undefined): void {
    if (openFor === this.openFor) return
    this.openFor = openFor
    for (const listener of this.listeners) listener()
  }
}

const HostContext = createContext<ArtifactTileHost | null>(null)

/** The list a file's or a link's tile is in. Must be used under an `ArtifactTiles`. */
export function useArtifactTileHost(): ArtifactTileHost {
  const host = use(HostContext)
  if (host === null) throw new Error('A file’s or a link’s tile must be under an ArtifactTiles')
  return host
}

/**
 * Whether the list's menu is open for this tile, by its child as one string (`refKey`). Only the tile whose answer
 * changes renders again: the one the menu opened for, and later the one it closed for.
 */
export function useTileMenuOpen(ref: string): boolean {
  const { watchMenu, menuOpenFor } = useArtifactTileHost()
  return useSyncExternalStore(watchMenu, () => menuOpenFor() === ref)
}

interface TodoImageViewerProps {
  readonly taskId: string
  /** The todo's image files, by path, in its list's order. */
  readonly paths: readonly string[]
  readonly viewed: ViewedImage
}

/**
 * The image viewer over one todo's images, there only while it's open: it reads the task's artifacts for their titles,
 * which the list around it never needs.
 */
function TodoImageViewer({ taskId, paths, viewed }: TodoImageViewerProps): React.JSX.Element {
  const artifacts = useGladeStore((state) => state.artifacts[taskId])
  const images = useMemo(
    () =>
      paths.flatMap((path) => {
        const artifact = findArtifact(artifacts, refKey({ kind: ChildKind.File, key: path }))
        return artifact?.kind === ArtifactKind.File ? [artifact] : []
      }),
    [artifacts, paths],
  )
  return <ArtifactImageViewer taskId={taskId} images={images} viewed={viewed} />
}

export interface ArtifactTilesProps {
  readonly taskId: string
  /** The children the list shows, in its order: the image files among them are what the viewer steps through. */
  readonly shown: readonly Child[]
  /** The list of tiles. */
  readonly children: ReactNode
}

/**
 * Around one todo's list of tiles in the hub (P16, #498): what its file and link tiles share with the Artifacts tab's
 * rows, kept once for the list. The context menu of an artifact (Open, …, Remove from artifacts, as
 * `docs/context-menus.md` has them) opens from a tile's right-click, ⇧F10 or More. The image viewer opens from an image
 * file's tile, and ← and → step only through the image files of this todo, in its list's order, never on into another
 * todo's; it closes if the image it shows leaves the todo (removed, or moved to another).
 */
export function ArtifactTiles({ taskId, shown, children }: ArtifactTilesProps): React.JSX.Element {
  const menu = useContextMenu<string>()
  const menuEntries = useArtifactMenu(taskId)
  const imagePaths = useMemo(
    () =>
      shown.flatMap(({ kind, key }) =>
        kind === ChildKind.File && fileTileKind(key) === FileTileKind.Image ? [key] : [],
      ),
    [shown],
  )
  const viewed = useViewedImage(imagePaths)

  // The artifact the menu is open for, as it is by now; while no menu is open, nothing of the task is read.
  const target = menu.opened?.target
  const menuArtifact = useGladeStore(
    useShallow((state) => (target === undefined ? undefined : findArtifact(state.artifacts[taskId], target))),
  )

  // The tile the menu is open for keeps its buttons showing (`useTileMenuOpen`), though the pointer and the focus
  // have left it for the menu. Opened: its tile is told at once, before the menu takes the focus from it, so the More
  // button the menu hangs from never leaves.
  const [menuWatch] = useState(() => new MenuWatch())
  const openFor = menuArtifact === undefined ? undefined : target
  useLayoutEffect(() => {
    if (openFor !== undefined) menuWatch.tell(openFor)
  }, [menuWatch, openFor])
  // Closed: its tile is told once the focus is back on what it left (which the menu does in a microtask as it goes,
  // ahead of this one), so the button is still there to take it.
  useEffect(() => {
    if (openFor !== undefined) return undefined
    let current = true
    queueMicrotask(() => {
      if (current) menuWatch.tell(undefined)
    })
    return () => {
      current = false
    }
  }, [menuWatch, openFor])

  const { targetProps, openBelow } = menu
  const { open: openImage } = viewed
  const host = useMemo<ArtifactTileHost>(
    () => ({
      menuTargetProps: targetProps,
      openMenu: openBelow,
      openImage,
      watchMenu: (listener) => menuWatch.watch(listener),
      menuOpenFor: () => menuWatch.openFor,
    }),
    [targetProps, openBelow, openImage, menuWatch],
  )
  return (
    <HostContext value={host}>
      {children}
      <ContextMenu
        label="Artifact actions"
        state={menu}
        // The artifact went while its menu was open: there's nothing left to act on.
        entries={() => (menuArtifact === undefined ? [] : menuEntries(menuArtifact))}
      />
      {viewed.path !== null && <TodoImageViewer taskId={taskId} paths={imagePaths} viewed={viewed} />}
    </HostContext>
  )
}
