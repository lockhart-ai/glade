import type { ReactNode } from 'react'
import { ContextMenu, linkMenu, useContextMenu, useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'
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
 * A link: clicking it (⌘-click too) or pressing ↵ on it opens it in your browser, through main (`links.open`), never in
 * Glade. When its text says something other than its address, hovering shows the address. Right-click it, or ⇧F10 on
 * it, for its own menu: Open link, Copy link. A link main refuses to open shows why as a toast.
 */
export function Link({ href, text, children }: LinkProps): React.JSX.Element {
  const openLink = useGladeStore((state) => state.openLink)
  const { run, copy } = useMenuCommands()
  const menu = useContextMenu<string>()
  const open = (): void => {
    run(() => openLink(href))
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
      {menu.opened !== null && (
        <ContextMenu
          label="Link actions"
          state={menu}
          entries={() =>
            linkMenu({
              open,
              copy: () => {
                copy(href)
              },
            })
          }
        />
      )}
    </>
  )
}
