import { useEffect } from 'react'
import { useGladeStore } from '../store/react'

/** Whether the key is ⌘F with no other modifier. */
function isSearchKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'f' && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

/** ⌘F focuses the sidebar's search field, selecting what's in it, wherever the focus is. */
export function useSearchShortcut(): void {
  const focusSearch = useGladeStore((state) => state.focusSearch)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSearchKey(event)) return
      event.preventDefault()
      focusSearch()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [focusSearch])
}
