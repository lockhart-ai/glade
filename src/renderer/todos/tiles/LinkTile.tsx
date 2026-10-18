import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { linkDetail, LinkKind, linkLabel, recogniseLink, type RecognisedLink } from '../../../shared/artifactLinks'
import { ArtifactKind, type LinkArtifact } from '../../../shared/domain'
import { ChildKind, refKey } from '../../../shared/todoHub'
import { LinkActions } from '../../artifacts/ArtifactActions'
import { useLinkArtifact } from '../../artifacts/artifactHooks'
import { artifactTime } from '../../artifacts/artifactsModel'
import { useGladeStore } from '../../store/react'
import { LinkStateLine, githubLinkIcon, tileIconClass } from '../LinkStateViews'
import { expandedStateItems } from '../linkWatchModel'
import { useArtifactTileHost, useTileMenuOpen } from './ArtifactTiles'
import { findArtifact } from './childIndex'
import { Tile, type KindTileProps } from './Tile'
import styles from './Tile.module.css'

/**
 * What a link's tag says under the pointer: a pull request's or an issue's repository with its number (`#511 ·
 * acme/api`), which its tag leaves out; for a ticket or any other page, whose tag is all there is to say, its address.
 */
export function linkTagTitle(link: RecognisedLink, url: string): string {
  switch (link.kind) {
    case LinkKind.PullRequest:
    case LinkKind.Issue:
      return linkDetail(link)
    case LinkKind.Ticket:
    case LinkKind.Web:
      return url
  }
}

interface LinkArtifactTileProps {
  readonly taskId: string
  readonly artifact: LinkArtifact
  /** Which child it is, as one string (`refKey`): what its context menu is opened for. */
  readonly childRef: string
}

/** The tile of a link the task has: `LinkTile`, once its artifact is found. */
function LinkArtifactTile({ taskId, artifact, childRef }: LinkArtifactTileProps): React.JSX.Element {
  const { url, title } = artifact
  const host = useArtifactTileHost()
  // What Open link and Copy link do.
  const { open, copy } = useLinkArtifact(artifact)
  const menuOpen = useTileMenuOpen(childRef)
  const { menuTargetProps } = host
  const menuTarget = useMemo(() => menuTargetProps(childRef), [menuTargetProps, childRef])
  const link = recogniseLink(url)
  // The watcher's last word of this very link (#682), by its address; nothing until the first poll reports.
  const watch = useGladeStore((state) => state.githubWatches[taskId]?.[url])
  const items = useMemo(() => (watch === undefined ? null : expandedStateItems(watch)), [watch])
  return (
    <Tile
      kind={ChildKind.Link}
      name={watch === undefined ? title : watch.title}
      icon={githubLinkIcon(url, watch)}
      iconClassName={watch === undefined ? undefined : tileIconClass(watch)}
      tag={linkLabel(link)}
      tagTitle={linkTagTitle(link, url)}
      at={artifactTime(artifact)}
      menuTarget={menuTarget}
      actionsPinned={menuOpen}
      onOpen={open}
      foot={items === null ? undefined : <LinkStateLine items={items} />}
      actions={
        <LinkActions
          buttonClassName={styles.action}
          onOpen={open}
          onCopy={copy}
          onMore={(button) => {
            host.openMenu(childRef, button)
          }}
        />
      }
    />
  )
}

/**
 * A link artifact's tile (#498): the icon
 * of what it is (a pull request, an issue, a ticket, a page), its title, then its number, its ticket's key or its
 * domain, from its address alone with no network call, and how long ago it last changed. A link the GitHub watcher
 * knows (#682, #683) says more under its title: what it is (open, a draft, in the merge queue, merged, closed), its
 * checks, its review and its comment count, each in its own colour, with its age at the line's far right, and the
 * watcher's own title for the link's. Clicking it, or ↵ or Space while it has the focus, opens it in the browser,
 * through main, never in Glade. Under the pointer or with the focus, its age gives way to three icon buttons: Open
 * link, Copy link and More, its context menu, which a right-click and ⇧F10 open too.
 */
export function LinkTile({ taskId, childKey }: KindTileProps): React.JSX.Element | null {
  const ref = refKey({ kind: ChildKind.Link, key: childKey })
  const artifact = useGladeStore(useShallow((state) => findArtifact(state.artifacts[taskId], ref)))
  if (artifact?.kind !== ArtifactKind.Link) return null
  return <LinkArtifactTile taskId={taskId} artifact={artifact} childRef={ref} />
}
