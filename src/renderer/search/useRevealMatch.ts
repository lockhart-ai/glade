import { useEffect, type RefObject } from 'react'
import { useGladeStore, useGladeStoreApi } from '../store/react'

/**
 * Whether `element` shows whole within the scroller's visible area: between its scroll paddings, where the header card
 * and the input bar float over the chat's top and bottom (see TaskCard.module.css).
 */
function inView(element: Element, scroller: Element): boolean {
  const box = element.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  const style = getComputedStyle(scroller)
  // An unset scroll padding reads as `auto`, which is none.
  const coveredTop = Number.parseFloat(style.scrollPaddingTop) || 0
  const coveredBottom = Number.parseFloat(style.scrollPaddingBottom) || 0
  return box.top >= view.top + coveredTop && box.bottom <= view.bottom - coveredBottom
}

/** Waits for the frame that shows what a load just put in the store, before looking for it in the DOM. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve()
    })
  })
}

/**
 * Each time a search result is opened (`matchRevealRequest`), smoothly scrolls the chat to its first marked match, if
 * that's off screen; a chat with no match, or one already showing it, stays where it is. A match in history the chat
 * hasn't loaded yet (#637): older pages load until the match is among them, then it reveals the same way.
 */
export function useRevealMatch(scroller: RefObject<HTMLElement | null>, taskId: string): void {
  const request = useGladeStore((state) => state.matchRevealRequest)
  const store = useGladeStoreApi()

  useEffect(() => {
    if (request === 0) return
    const run = { cancelled: false }
    const cancelled = (): boolean => run.cancelled
    const reveal = async (): Promise<void> => {
      for (;;) {
        await nextFrame()
        const element = scroller.current
        if (element === null || cancelled()) return
        const match = element.querySelector('mark')
        if (match !== null) {
          if (!inView(match, element)) match.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return
        }
        // No match showing: it may be in history not loaded yet. Stop when there's none older to bring in, the
        // request moved on, or a load failed.
        const tail = store.getState().historyTails[taskId]
        if (tail?.hasOlderMessages !== true || cancelled()) return
        const loaded = await store
          .getState()
          .loadOlderHistory(taskId)
          .then(
            () => true,
            () => false,
          )
        if (!loaded || cancelled()) return
      }
    }
    void reveal()
    return () => {
      run.cancelled = true
    }
  }, [request, scroller, store, taskId])
}
