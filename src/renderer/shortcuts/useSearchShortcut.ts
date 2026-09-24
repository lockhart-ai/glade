import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { collapsedEntry, isCollapsed, Panel } from '../panels'
import { useGladeStoreApi } from '../store/react'

/** Whether the key is ⌘F with no other modifier. */
function isSearchKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'f' && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

/**
 * ⌘F focuses the sidebar's search field, selecting what's in it, wherever the focus is. With the sidebar collapsed, it
 * shows the sidebar first (a stored change, as its button makes), so the field is there to take the focus.
 */
export function useSearchShortcut(): void {
  const store = useGladeStoreApi()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSearchKey(event)) return
      event.preventDefault()
      const { uiState, setUiState, focusSearch } = store.getState()
      if (isCollapsed(uiState, Panel.Sidebar)) {
        // Rendered at once, so the field has mounted before it's asked to take the focus.
        flushSync(() => {
          void setUiState(collapsedEntry(Panel.Sidebar, false))
        })
      }
      focusSearch()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [store])
}
