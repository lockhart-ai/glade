import type { ReactNode } from 'react'
import { checkArtifactUrl } from '../../shared/artifactLinks'
import { ArtifactKind } from '../../shared/domain'
import { ContextMenu, linkMenu, useContextMenu, useMenuCommands, type MenuAction } from '../context-menus'
import { useGladeStore } from '../store/react'
import type { GladeState } from '../store/state'
import { linkTitle } from './linkify'
import styles from './Link.module.css'

export interface LinkProps {
  /** The address, one Glade opens (`openableUrl`): only a web or mail link is ever made a link. */
  readonly href: string
  /** What the link says, which its tooltip is left off for when it's the address itself. */
  readonly text: string
  readonly children: ReactNode
}

/**
 * Whether a link can be added to the selected task's artifacts (#407): there's a task open, it's a web page (`http:`
 * or `https:`, not `mailto:`), and it isn't one of the task's artifacts already. Answers the task, or null.
 */
function artifactTask(state: GladeState, href: string): string | null {
  const taskId = state.selectedTaskId
  const check = checkArtifactUrl(href)
  if (taskId === null || !check.ok) return null
  const artifacts = state.artifacts[taskId] ?? []
  const added = artifacts.some((artifact) => artifact.kind === ArtifactKind.Link && artifact.url === check.url)
  return added ? null : taskId
}

/**
 * A link: clicking it (⌘-click too) or pressing ↵ on it opens it in your browser, through main (`links.open`), never in
 * Glade. When its text says something other than its address, hovering shows the address. Right-click it, or ⇧F10 on
 * it, for its own menu: Open link, Copy link, and Add to artifacts, which adds a web link to the open task's artifacts
 * (#407). A link main refuses to open shows why as a toast.
 */
export function Link({ href, text, children }: LinkProps): React.JSX.Element {
  const openLink = useGladeStore((state) => state.openLink)
  const addLinkArtifact = useGladeStore((state) => state.addLinkArtifact)
  const { run, copy } = useMenuCommands()
  const menu = useContextMenu<string>()
  const menuOpen = menu.opened !== null
  // Only looked at while the menu is open, so a change to the task's artifacts doesn't redraw every link.
  const addTo = useGladeStore((state) => (menuOpen ? artifactTask(state, href) : null))
  const open = (): void => {
    run(() => openLink(href))
  }
  const addToArtifacts: MenuAction | null =
    addTo === null
      ? null
      : () => {
          run(() => addLinkArtifact(addTo, href, text))
        }
  return (
    <>
      <a
        href={href}
        title={linkTitle(text, href)}
        className={styles.link}
        onClick={(event) => {
          // The window never follows a link: main opens it in the browser.
          event.preventDefault()
          event.stopPropagation()
          open()
        }}
        {...menu.targetProps(href)}
      >
        {children}
      </a>
      {/* Beside the link, not in it: the menu's clicks would otherwise reach the link through React. */}
      {menuOpen && (
        <ContextMenu
          label="Link actions"
          state={menu}
          entries={() =>
            linkMenu({
              open,
              copy: () => {
                copy(href)
              },
              addToArtifacts,
            })
          }
        />
      )}
    </>
  )
}
