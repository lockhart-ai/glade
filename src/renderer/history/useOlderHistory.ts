/**
 * Loading a task's older history as you scroll up (#637): a task's history loads as its last screenful, and the chat
 * and the tool log ask for the next older page (`loadOlderHistory`) when the scroll comes near their top, keeping
 * their place as the page adds content above.
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { useGladeStoreApi } from '../store/react'

/** How close to the top of a scroller, in pixels, counts as near enough to load the next older page. */
export const LOAD_OLDER_WITHIN_PX = 300

/**
 * The `onScroll` work that loads older history: call it from a scroller's scroll handler, after its own; it asks the
 * store for the task's next older page (`loadOlderHistory`, which does nothing while one is loading or none is left)
 * when the scroller is within `LOAD_OLDER_WITHIN_PX` of its top, and only when `active` — the task's own log, not a
 * subagent's, which loads whole when its tab opens.
 */
export function useLoadOlderOnScroll(
  scroller: RefObject<HTMLElement | null>,
  taskId: string,
  active: boolean,
): () => void {
  const store = useGladeStoreApi()
  return useCallback(() => {
    if (!active) return
    const element = scroller.current
    if (element === null || element.scrollTop > LOAD_OLDER_WITHIN_PX) return
    store
      .getState()
      .loadOlderHistory(taskId)
      .catch(() => undefined)
  }, [active, scroller, store, taskId])
}

/**
 * Moves a scroller's scroll down by `by`, which an older page just added above the viewport.
 */
function shiftDown(element: HTMLElement, by: number): void {
  element.scrollTop = element.scrollTop + by
}

/**
 * Keeps a scroller's place when a page of older history adds content above it (#637): the scroll moves down by the
 * height the page added, so what the viewport showed stays in it. Reads `firstId` — the id of the first row the
 * scroller shows — and only adjusts when it changed for the same task, which is what a prepend does; a live event's
 * row, added at the bottom, leaves the place alone, as does another task's. `content` is whatever the scroller's rows
 * are made from, so the height it remembers is the one before the change that prepended.
 */
export function useKeepScrollOnPrepend(
  scroller: RefObject<HTMLElement | null>,
  firstId: string | null,
  taskId: string,
  active: boolean,
  content: unknown,
): void {
  const previous = useRef<{
    readonly taskId: string
    readonly firstId: string | null
    readonly height: number
  } | null>(null)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    const before = previous.current
    if (
      active &&
      before !== null &&
      before.taskId === taskId &&
      before.firstId !== null &&
      before.firstId !== firstId
    ) {
      shiftDown(element, element.scrollHeight - before.height)
    }
    previous.current = { taskId, firstId, height: element.scrollHeight }
  }, [active, content, firstId, scroller, taskId])
}
