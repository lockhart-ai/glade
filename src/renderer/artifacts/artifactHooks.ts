/**
 * What an artifact does, wherever it shows: in its row in the Artifacts tab, and on its tile in the todo hub (P16,
 * #498). One of each, so the two can't drift: how a file is looked at (its thumbnail, whether it's gone), what opening
 * and revealing it do, what a link's Open and Copy do, and the items of an artifact's context menu.
 */
import { useCallback, useEffect, useState } from 'react'
import { artifactRef } from '../../shared/artifacts'
import {
  ArtifactKind,
  FileThumbnailKind,
  type Artifact,
  type EpochMs,
  type FileArtifact,
  type FileThumbnail,
  type LinkArtifact,
} from '../../shared/domain'
import type { MenuEntry } from '../components'
import { artifactMenu, linkArtifactMenu, useMenuCommands } from '../context-menus'
import { absolutePath } from '../files/FilesTab'
import { useGladeStore } from '../store/react'
import { artifactTime, artifactTypeName, isImageArtifact } from './artifactsModel'

/** A file artifact as its row or its tile shows it, and what its buttons do. */
export interface FileArtifactView {
  /** Whether the image viewer can open it (PNG, JPEG, GIF, WebP or SVG), by its path. */
  readonly isImage: boolean
  /** Whether its file is gone: it shows muted, as missing, and can't be opened or revealed. */
  readonly missing: boolean
  /** Its thumbnail, as a data URL, once main has made one; null until then, and for anything but an image. */
  readonly image: string | null
  /** Whether it's still being looked at, or its thumbnail hasn't loaded yet: a capture waits for it. */
  readonly busy: boolean
  /** What it says after its title: its type (`Markdown`, `PNG`), and that it's missing when it is. */
  readonly typeLabel: string
  /** When its file last changed (`artifactTime`). */
  readonly time: EpochMs
  /** For its thumbnail's `<img>`: it has loaded. */
  readonly onThumbnailLoad: () => void
  /** For its thumbnail's `<img>`: the window can't draw it, so its type's icon shows instead. */
  readonly onThumbnailError: () => void
  /** Opens it in the Files tab; if that fails, the file is looked at again. */
  readonly showInFiles: () => void
  /** Reveals it in its folder, through main; if that fails, the file is looked at again. */
  readonly reveal: () => void
}

/**
 * Looks at a file artifact, through main (`files.thumbnail`): when it first shows, when its file changes, and after an
 * action on it failed. Until main has answered, nothing is known of it: it isn't missing, and has no thumbnail.
 */
export function useFileArtifact(artifact: FileArtifact): FileArtifactView {
  const { taskId, path, modifiedAt, missing: gone } = artifact
  const fileThumbnail = useGladeStore((state) => state.fileThumbnail)
  const showFile = useGladeStore((state) => state.showFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const [thumbnail, setThumbnail] = useState<FileThumbnail>()
  // The thumbnail that has loaded, which shows.
  const [loaded, setLoaded] = useState<string | null>(null)
  const [looks, setLooks] = useState(0)

  useEffect(() => {
    let current = true
    void fileThumbnail(taskId, path).then(
      (next) => {
        if (current) setThumbnail(next)
      },
      () => {
        if (current) setThumbnail({ kind: FileThumbnailKind.None })
      },
    )
    return () => {
      current = false
    }
  }, [fileThumbnail, taskId, path, modifiedAt, gone, looks])

  const lookAgain = useCallback(() => {
    setLooks((count) => count + 1)
  }, [])

  const missing = gone || thumbnail?.kind === FileThumbnailKind.Missing
  const image = thumbnail?.kind === FileThumbnailKind.Image ? thumbnail.dataUrl : null
  const type = artifactTypeName(artifact)
  return {
    isImage: isImageArtifact(artifact),
    missing,
    image,
    busy: thumbnail === undefined || (image !== null && loaded !== image),
    typeLabel: missing ? `${type} · missing` : type,
    time: artifactTime(artifact),
    onThumbnailLoad: () => {
      setLoaded(image)
    },
    onThumbnailError: () => {
      setThumbnail({ kind: FileThumbnailKind.None })
    },
    showInFiles: () => void showFile(taskId, path).catch(lookAgain),
    reveal: () => void revealFile(taskId, path).catch(lookAgain),
  }
}

/** What a link artifact's row or tile does. */
export interface LinkArtifactActions {
  /** Opens it in the browser, through main, as any link does; it never opens in Glade. A failure shows as a toast. */
  readonly open: () => void
  /** Puts its address on the clipboard. */
  readonly copy: () => void
}

/** A link artifact's Open link and Copy link. Must be used under a `ToastProvider`. */
export function useLinkArtifact({ url }: LinkArtifact): LinkArtifactActions {
  const openLink = useGladeStore((state) => state.openLink)
  const { run, copy } = useMenuCommands()
  return {
    open: () => {
      run(() => openLink(url))
    },
    copy: () => {
      copy(url)
    },
  }
}

/**
 * The items of an artifact's context menu (`docs/context-menus.md`), from a right-click, ⇧F10 or its More button: for a
 * file, Open, Open in editor, Copy contents, Copy path, Reveal in Finder and Remove from artifacts, which leaves the
 * file; for a link, Open link, Copy link and Remove from artifacts. Each failure shows as a toast. Must be used under a
 * `ToastProvider`.
 */
export function useArtifactMenu(taskId: string): (artifact: Artifact) => MenuEntry[] {
  const rootPath = useGladeStore(
    (state) => state.workspaces.find((workspace) => workspace.id === state.tasks[taskId]?.workspaceId)?.rootPath,
  )
  const showFile = useGladeStore((state) => state.showFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const copyFile = useGladeStore((state) => state.copyFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const removeArtifact = useGladeStore((state) => state.removeArtifact)
  const openLink = useGladeStore((state) => state.openLink)
  const { run, copy, hints } = useMenuCommands()

  return (artifact) => {
    const remove = (): void => {
      run(() => removeArtifact(taskId, artifactRef(artifact)))
    }
    if (artifact.kind === ArtifactKind.Link) {
      const { url } = artifact
      return linkArtifactMenu(
        {
          open: () => {
            run(() => openLink(url))
          },
          copy: () => {
            copy(url)
          },
          remove,
        },
        hints,
      )
    }
    const { path } = artifact
    return artifactMenu(
      {
        open: () => {
          run(() => showFile(taskId, path))
        },
        openInEditor: () => {
          run(() => openInEditor(taskId, path))
        },
        copyContents: () => {
          run(() => copyFile(taskId, path))
        },
        copyPath: () => {
          copy(rootPath === undefined ? path : absolutePath(rootPath, path))
        },
        reveal: () => {
          run(() => revealFile(taskId, path))
        },
        remove,
      },
      hints,
    )
  }
}
