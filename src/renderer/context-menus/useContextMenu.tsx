import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Menu, MenuAnchorKind, type MenuAnchor, type MenuEntry } from '../components'

/** Whether a key press opens the context menu of what has the focus: ⇧F10, or the keyboard's context-menu key. */
export function isContextMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'altKey' | 'ctrlKey'>) {
  if (event.metaKey || event.altKey || event.ctrlKey) return false
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

/** A context menu that's open: what it's for, and where. */
export interface OpenContextMenu<T> {
  readonly target: T
  readonly anchor: MenuAnchor
}

/** What makes an element open a context menu: a right-click on it, or ⇧F10 while it (or something in it) has the focus. */
export interface ContextMenuTargetProps {
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export interface ContextMenuState<T> {
  /** The open menu, or null while it's closed. */
  readonly opened: OpenContextMenu<T> | null
  /** The props that make an element open the menu for `target`. */
  readonly targetProps: (target: T) => ContextMenuTargetProps
  readonly close: () => void
}

/**
 * One context menu for a set of targets, such as the rows of a list: each row spreads `targetProps(row)`, and the menu
 * (`ContextMenu`) opens for the row it was asked on. A right-click opens it at the pointer; ⇧F10 or the context-menu key
 * opens it below the focused row. The innermost target wins: opening it stops the event there, so a row inside another
 * row opens its own menu.
 */
export function useContextMenu<T>(): ContextMenuState<T> {
  const [opened, setOpened] = useState<OpenContextMenu<T> | null>(null)
  const targetProps = useCallback(
    (target: T): ContextMenuTargetProps => ({
      onContextMenu: (event) => {
        event.preventDefault()
        event.stopPropagation()
        setOpened({ target, anchor: { kind: MenuAnchorKind.Point, x: event.clientX, y: event.clientY } })
      },
      onKeyDown: (event) => {
        if (!isContextMenuKey(event)) return
        event.preventDefault()
        event.stopPropagation()
        setOpened({ target, anchor: { kind: MenuAnchorKind.Element, element: event.currentTarget } })
      },
    }),
    [],
  )
  const close = useCallback(() => {
    setOpened(null)
  }, [])
  return { opened, targetProps, close }
}

/** Where a closed menu is anchored: nowhere it shows. */
const NOWHERE: MenuAnchor = { kind: MenuAnchorKind.Point, x: 0, y: 0 }

export interface ContextMenuProps<T> {
  /** The menu's accessible name, e.g. "Task actions". */
  readonly label: string
  readonly state: ContextMenuState<T>
  /** The menu's entries for a target. A target with none opens no menu. */
  readonly entries: (target: T) => readonly MenuEntry[]
}

/** The context menu `state` opened, with the entries for its target. */
export function ContextMenu<T>({ label, state, entries }: ContextMenuProps<T>): React.JSX.Element {
  const { opened, close } = state
  const shown = opened === null ? [] : entries(opened.target)
  return (
    <Menu
      label={label}
      entries={shown}
      anchor={opened?.anchor ?? NOWHERE}
      open={opened !== null && shown.length > 0}
      onClose={close}
    />
  )
}
