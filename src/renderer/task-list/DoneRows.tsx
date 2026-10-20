import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Task } from '../../shared/domain'
import { classNames } from '../components/classNames'
import styles from './TaskList.module.css'

/** A row's height before it's measured: a title line and a status line (TaskRow.module.css). */
const DONE_ROW_ESTIMATE = 60
/** The space between rows, as `.rows` has it (`--space-2xs`). */
const ROW_GAP = 2
/** How many rows to render past each edge of what shows, so a quick scroll doesn't flash empty space. */
const OVERSCAN = 10
/** How close to the last loaded row the rendered rows get before the next page loads. */
const PREFETCH_ROWS = 30

/** How far down the page an element is laid out, whatever is scrolled: its offsets up to the top. */
function layoutTop(element: HTMLElement): number {
  let top = 0
  for (let at: Element | null = element; at instanceof HTMLElement; at = at.offsetParent) top += at.offsetTop
  return top
}

export interface DoneRowsProps {
  /** The list's id, which the section header controls. */
  listId: string
  /** The Done section's tasks loaded so far, in order. */
  tasks: readonly Task[]
  /** Whether more tasks follow the last loaded. */
  hasMore: boolean
  /** The task list's scroller, which the rows scroll in; null until it's mounted. */
  scroller: HTMLElement | null
  /** Loads the next page, once the rows rendered near the last loaded. */
  onEndReached: () => void
  selectedTaskId: string | null
  /** The last done task the selection was scrolled to, kept by the task list across this section's opens and shuts. */
  revealedSelection: RefObject<string | null>
  /** One task's row. */
  row: (task: Task) => ReactNode
}

/**
 * The Done section's rows, which can run to thousands: only those in or near view are rendered (`@tanstack/react-virtual`),
 * each in its place in a list as tall as all of them, so the list scrolls as if they were all there. Scrolling near the
 * last loaded row loads the next page. Mounting takes the scroll as it finds it (TanStack would otherwise reset it to
 * the top, #753), and a selected task scrolls into view once each time it becomes the selection, not again when the
 * section reopens.
 */
export function DoneRows({
  listId,
  tasks,
  hasMore,
  scroller,
  onEndReached,
  selectedTaskId,
  revealedSelection,
  row,
}: DoneRowsProps): React.JSX.Element {
  const list = useRef<HTMLUListElement>(null)
  // Where the rows start in the scroller's content, below the Pinned and Active sections.
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    const element = list.current
    if (element === null || scroller === null) return undefined
    const measure = (): void => {
      setScrollMargin(layoutTop(element) - layoutTop(scroller))
    }
    measure()
    // The rows move whenever what's above them changes size: a section collapsing, or gaining or losing a task.
    const observer = new ResizeObserver(measure)
    for (const child of Array.from(scroller.children)) observer.observe(child)
    return () => {
      observer.disconnect()
    }
  }, [scroller])

  // TanStack Virtual hands back a new measurement each render, which the React Compiler can't memoize: it leaves this
  // component alone, as it should.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scroller,
    estimateSize: () => DONE_ROW_ESTIMATE,
    getItemKey: (index) => tasks[index]?.id ?? index,
    gap: ROW_GAP,
    overscan: OVERSCAN,
    scrollMargin,
    // Where the list is scrolled, for the mount below: TanStack's default of 0 would scroll it to the top (#753).
    initialOffset: () => scroller?.scrollTop ?? 0,
  })
  const items = virtualizer.getVirtualItems()

  const lastRendered = items.at(-1)?.index ?? -1
  useEffect(() => {
    if (hasMore && lastRendered >= tasks.length - 1 - PREFETCH_ROWS) onEndReached()
  }, [hasMore, lastRendered, tasks.length, onEndReached])

  // Scroll to a task once each time it becomes the selection, and not again as you scroll away from it — nor when the
  // section reopens, which remounts these rows: the memory of what was revealed lives above this component.
  const selectedIndex = tasks.findIndex(({ id }) => id === selectedTaskId)
  useEffect(() => {
    if (selectedTaskId === null || selectedIndex === -1) {
      revealedSelection.current = null
      return
    }
    if (revealedSelection.current === selectedTaskId || scroller === null) return
    revealedSelection.current = selectedTaskId
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto' })
  }, [selectedTaskId, selectedIndex, scroller, virtualizer, revealedSelection])

  return (
    <ul
      id={listId}
      ref={list}
      className={classNames(styles.rows, styles.virtual)}
      style={{ height: virtualizer.getTotalSize() }}
    >
      {items.map((item) => {
        const task = tasks[item.index]
        if (task === undefined) return null
        return (
          <li
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className={styles.virtualRow}
            style={{ transform: `translateY(${String(item.start - scrollMargin)}px)` }}
          >
            {row(task)}
          </li>
        )
      })}
    </ul>
  )
}
