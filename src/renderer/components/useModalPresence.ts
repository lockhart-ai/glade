import { useEffect } from 'react'
import { useGladeStore } from '../store/react'

/**
 * Registers a modal (Settings, a confirm dialog, the image viewer) as open for as long as `open` is true, bumping
 * `openModalCount`; unmounting, or `open` going false, drops it back down. The input bar's focus effect (`InputBar`)
 * holds off while any modal is open, and focuses the task's input once the last one closes (#415).
 */
export function useModalPresence(open: boolean): void {
  const modalOpened = useGladeStore((state) => state.modalOpened)
  const modalClosed = useGladeStore((state) => state.modalClosed)
  useEffect(() => {
    if (!open) return
    modalOpened()
    return () => {
      modalClosed()
    }
  }, [open, modalOpened, modalClosed])
}
