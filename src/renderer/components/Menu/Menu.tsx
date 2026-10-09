import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
  useTypeahead,
} from '@floating-ui/react'
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { faCheck, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { matchesWords } from '../../../shared/textMatch'
import { classNames } from '../classNames'
import { Icon, IconSize } from '../Icon/Icon'
import { useOverlayRef } from '../overlays'
import { Placement } from '../Placement'
import styles from './Menu.module.css'

export enum MenuEntryKind {
  Item = 'item',
  Separator = 'separator',
  Heading = 'heading',
}

export enum MenuItemVariant {
  Default = 'default',
  /** Pink, for an action that deletes or stops something. It sits last in the menu. */
  Destructive = 'destructive',
}

/** An action in a menu. */
export interface MenuItem {
  kind: MenuEntryKind.Item
  label: string
  /** An icon before the label. */
  icon?: IconDefinition
  /** The action's keyboard shortcut, shown at the right as a hint, e.g. "⌘⇧P". */
  shortcut?: string
  variant?: MenuItemVariant
  /**
   * Makes the item one of a set of choices (a picker's options): true for the chosen one, which shows a check at the
   * right. Leave it out for a plain action.
   */
  checked?: boolean
  /**
   * What the item shows in place of its label, shortcut and check, for an item with more to it than a label (a
   * workspace in the switcher). `label` still names it, for typeahead and assistive technology.
   */
  content?: ReactNode
  /** A class for the item's button, to lay out its `content`. */
  className?: string
  /** Runs when the item is chosen, after the menu closes. */
  onSelect: () => void
}

/** A line between groups of items. */
export interface MenuSeparator {
  kind: MenuEntryKind.Separator
}

/** A small label over a group of items, e.g. "Changed" over the files the agent changed. It can't be chosen. */
export interface MenuHeading {
  kind: MenuEntryKind.Heading
  label: string
}

export type MenuEntry = MenuItem | MenuSeparator | MenuHeading

export enum MenuAnchorKind {
  /** At a point in the window, e.g. where a right-click happened. */
  Point = 'point',
  /** Beside an element, e.g. the button that opens a dropdown. */
  Element = 'element',
}

/** Opens the menu at a point, in viewport coordinates (a mouse event's `clientX` and `clientY`). */
export interface MenuPointAnchor {
  kind: MenuAnchorKind.Point
  x: number
  y: number
}

/** Opens the menu beside an element. */
export interface MenuElementAnchor {
  kind: MenuAnchorKind.Element
  element: HTMLElement | null
  /** Defaults to below the element, aligned to its start. */
  placement?: Placement
}

export type MenuAnchor = MenuPointAnchor | MenuElementAnchor

export interface MenuProps {
  /** The menu's accessible name, e.g. "Task actions". */
  label: string
  entries: readonly MenuEntry[]
  anchor: MenuAnchor
  open: boolean
  /** Called when the menu should close: an item was chosen, or Esc or a click outside dismissed it. */
  onClose: () => void
  className?: string
  /**
   * Shows a small search field above the items, which filters them to those whose label matches as you type (#566, the
   * provider menus). An item matches when every word of the query appears in its label, diacritics folded.
   */
  searchPlaceholder?: string
  /** Caps the items' height and scrolls them, for a menu with a long list, like a model's providers (#566). */
  scrollable?: boolean
}

/** Gap between the menu and what it's anchored to. */
const OFFSET = 4
/** How close the menu may come to the window's edge. */
const EDGE_PADDING = 8

/** A zero-size rectangle at a point, for anchoring the menu to where the user clicked. */
function pointRect(x: number, y: number): DOMRect {
  return { x, y, width: 0, height: 0, top: y, left: x, right: x, bottom: y, toJSON: () => ({ x, y }) }
}

/**
 * A context or dropdown menu. It is controlled: open it on a right-click (anchored at the pointer) or from a button
 * (anchored to it), and close it in `onClose`. ↑ and ↓ move between items and wrap, ↵ chooses, typing jumps to an
 * item by its label, and Esc or a click outside closes it. Focus returns to where it was when the menu opened.
 *
 * With `searchPlaceholder`, a small search field sits above the items and filters them as you type (#566): the words
 * of the query must all appear in an item's label, folded, and while the field holds text the typeahead stands down.
 * With `scrollable`, the items scroll within a capped list.
 */
export function Menu({
  label,
  entries,
  anchor,
  open,
  onClose,
  className,
  searchPlaceholder,
  scrollable = false,
}: MenuProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  // A fresh search each time the menu opens, whatever the last one left there: when `open` changes, the query empties
  // with the close, in the same render (React's way of adjusting state when a prop changes).
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setQuery('')
  }
  const listRef = useRef<(HTMLElement | null)[]>([])
  const labelsRef = useRef<(string | null)[]>([])
  // The entries the menu shows: all of them, or the ones the search field's query matches, where a heading survives
  // while some item under it does, and separators go when anything is filtered out.
  const shown = filterEntries(entries, query)
  // Where each item falls in the shown entries, so an item's position in the list skips the separators and headings.
  const itemEntries = shown.flatMap((entry, index) => (entry.kind === MenuEntryKind.Item ? [index] : []))

  const isPoint = anchor.kind === MenuAnchorKind.Point
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) onClose()
    },
    placement: isPoint ? 'right-start' : (anchor.placement ?? Placement.BottomStart),
    middleware: [
      offset(isPoint ? 0 : OFFSET),
      flip({ fallbackPlacements: isPoint ? ['left-start'] : undefined, padding: EDGE_PADDING }),
      shift({ padding: EDGE_PADDING }),
    ],
    whileElementsMounted: autoUpdate,
  })

  const x = isPoint ? anchor.x : 0
  const y = isPoint ? anchor.y : 0
  const element = isPoint ? null : anchor.element
  useLayoutEffect(() => {
    // Set both references each time, so a point left over from a right-click can't position a dropdown.
    if (isPoint) {
      refs.setReference(null)
      refs.setPositionReference({ getBoundingClientRect: () => pointRect(x, y) })
    } else {
      refs.setReference(element)
      refs.setPositionReference(element)
    }
  }, [refs, isPoint, x, y, element])

  useLayoutEffect(() => {
    labelsRef.current = shown.flatMap((entry) => (entry.kind === MenuEntryKind.Item ? [entry.label] : []))
  }, [shown])

  const overlay = useOverlayRef()
  const setFloating = useCallback(
    (node: HTMLElement | null) => {
      refs.setFloating(node)
      overlay(node)
    },
    [refs, overlay],
  )

  const { getFloatingProps, getItemProps } = useInteractions([
    useDismiss(context),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, loop: true }),
    // While the search field holds text, typing there is the search's: the typeahead stands down.
    useTypeahead(context, {
      listRef: labelsRef,
      activeIndex,
      onMatch: (index) => {
        if (query === '') setActiveIndex(index)
      },
    }),
  ])

  if (!open) return <></>

  function choose(item: MenuItem): void {
    onClose()
    item.onSelect()
  }

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} initialFocus={refs.floating}>
        <div
          ref={setFloating}
          aria-label={label}
          className={classNames(styles.menu, className)}
          style={floatingStyles}
          {...getFloatingProps()}
          // Its name is its label, whatever it's anchored to: Floating UI would name it after an anchor that has an
          // id (an agent's tab, whose menu the keyboard opens from the tab itself), over the label.
          aria-labelledby={undefined}
        >
          {searchPlaceholder !== undefined && (
            <label className={styles.search}>
              <Icon icon={faMagnifyingGlass} size={IconSize.Medium} className={styles.searchIcon} />
              <input
                type="text"
                aria-label={searchPlaceholder}
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                }}
              />
            </label>
          )}
          <div className={classNames(scrollable && styles.list)}>
            {shown.map((entry, entryIndex) => {
              switch (entry.kind) {
                case MenuEntryKind.Separator:
                  return <div key={entryIndex} role="separator" className={styles.separator} />
                case MenuEntryKind.Heading:
                  return (
                    <div key={entryIndex} role="presentation" className={styles.heading}>
                      {entry.label}
                    </div>
                  )
                case MenuEntryKind.Item: {
                  const index = itemEntries.indexOf(entryIndex)
                  return (
                    <button
                      key={entryIndex}
                      ref={(button) => {
                        listRef.current[index] = button
                      }}
                      type="button"
                      role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
                      aria-checked={entry.checked}
                      tabIndex={-1}
                      aria-label={entry.content === undefined ? undefined : entry.label}
                      className={classNames(
                        styles.item,
                        entry.variant === MenuItemVariant.Destructive && styles.destructive,
                        entry.className,
                      )}
                      {...getItemProps({
                        onClick: () => {
                          choose(entry)
                        },
                        onKeyDown: (event: KeyboardEvent) => {
                          if (event.key !== 'Enter') return
                          // Choose here rather than let the button turn Enter into a click, so it works the same
                          // everywhere.
                          event.preventDefault()
                          choose(entry)
                        },
                      })}
                    >
                      {entry.content ?? (
                        <>
                          <span className={styles.label}>
                            {entry.icon !== undefined && (
                              <Icon icon={entry.icon} size={IconSize.Medium} className={styles.icon} />
                            )}
                            {entry.label}
                          </span>
                          {entry.shortcut !== undefined && <kbd className={styles.shortcut}>{entry.shortcut}</kbd>}
                          {entry.checked === true && (
                            <Icon icon={faCheck} size={IconSize.Medium} className={styles.check} />
                          )}
                        </>
                      )}
                    </button>
                  )
                }
              }
            })}
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  )
}

/**
 * The entries a menu shows for a search query: with none, all of them; with one, the items whose label every word of
 * the query matches (`matchesWords`), the headings that still lead kept items, and the separators between things that
 * are still there, collapsed into one where the filtering left them side by side.
 */
function filterEntries(entries: readonly MenuEntry[], query: string): readonly MenuEntry[] {
  if (query.trim() === '') return entries
  const keptItems = new Set(
    entries.flatMap((entry, index) =>
      entry.kind === MenuEntryKind.Item && matchesWords(query, entry.label) ? [index] : [],
    ),
  )
  const kept = entries.flatMap((entry, index): readonly MenuEntry[] => {
    switch (entry.kind) {
      case MenuEntryKind.Item:
        return keptItems.has(index) ? [entry] : []
      case MenuEntryKind.Heading: {
        const nextHeading = entries.findIndex(
          (later, laterIndex) => laterIndex > index && later.kind === MenuEntryKind.Heading,
        )
        const end = nextHeading === -1 ? entries.length : nextHeading
        return entries.some((_, laterIndex) => laterIndex > index && laterIndex < end && keptItems.has(laterIndex))
          ? [entry]
          : []
      }
      case MenuEntryKind.Separator: {
        const before = entries.some((_, earlierIndex) => earlierIndex < index && keptItems.has(earlierIndex))
        const after = entries.some((_, laterIndex) => laterIndex > index && keptItems.has(laterIndex))
        return before && after ? [entry] : []
      }
    }
  })
  // Runs of separators the filtering left next to each other collapse into one, and none leads or trails.
  const collapsed = kept.filter(
    (entry, index) =>
      entry.kind !== MenuEntryKind.Separator || (index > 0 && kept[index - 1]?.kind !== MenuEntryKind.Separator),
  )
  while (collapsed.at(-1)?.kind === MenuEntryKind.Separator) collapsed.pop()
  return collapsed
}
