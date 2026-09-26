import { useEffect, useRef, useState } from 'react'
import { CommandName, EventType, type GladeBridge } from '../../shared/bridge'
import { EMPTY_MENU_BAR_SNAPSHOT, type MenuBarSnapshot } from '../../shared/menuBar'
import { useNow } from '../task-list/useNow'
import { menuBarSections } from './menuBarModel'
import { MenuBarPopover } from './MenuBarPopover'

/** The popover's border, above and below its content (`MenuBar.module.css`), in CSS pixels. */
export const POPOVER_BORDERS = 2

/** How often the popover's times move on: elapsed times count seconds. */
export const MENU_BAR_TICK_MS = 1_000

export interface MenuBarPageProps {
  bridge: GladeBridge
  /** What's in flight as the page opened (`menuBar.get`), until main sends a change. */
  initial: Promise<MenuBarSnapshot>
}

/**
 * The menu bar popover's page (`#menu-bar`), in its own small window: what's in flight, as main last sent it, kept up
 * to date while it's open. It asks main to size its window to it as it changes, hides on Esc, and hands a clicked row,
 * Open Glade and Quit to main.
 */
export function MenuBarPage({ bridge, initial }: MenuBarPageProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<MenuBarSnapshot | null>(null)
  const now = useNow(MENU_BAR_TICK_MS)
  const content = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === EventType.MenuBarChanged) setSnapshot(event.snapshot)
    })
    // A change main sent while this was on its way is newer: it stays.
    void initial.then(
      (loaded) => {
        if (live) setSnapshot((current) => current ?? loaded)
      },
      () => {
        if (live) setSnapshot((current) => current ?? EMPTY_MENU_BAR_SNAPSHOT)
      },
    )
    return () => {
      live = false
      unsubscribe()
    }
  }, [bridge, initial])

  useEffect(() => {
    const element = content.current
    if (element === null) return
    // Its window is sized to what it lists: the content's height, and the popover's border above and below it.
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(element.getBoundingClientRect().height) + POPOVER_BORDERS
      void bridge.invoke(CommandName.MenuBarFit, { height })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [bridge])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void bridge.invoke(CommandName.MenuBarHide, {})
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [bridge])

  return (
    <MenuBarPopover
      sections={snapshot === null ? [] : menuBarSections(snapshot, now)}
      contentRef={content}
      onOpenTask={(id) => {
        // A task deleted since the popover listed it can't be opened: its row goes with the next change.
        bridge.invoke(CommandName.MenuBarOpenTask, { id }).catch(() => undefined)
      }}
      onOpenGlade={() => {
        void bridge.invoke(CommandName.MenuBarOpenGlade, {})
      }}
      onQuit={() => {
        void bridge.invoke(CommandName.MenuBarQuit, {})
      }}
    />
  )
}
