import { flushSync } from 'react-dom'
import { WindowCommandId } from '../../shared/commands'
import { useCommands } from '../commands/hooks'
import { collapsedEntry, isCollapsed, Panel } from '../panels'
import { useGladeStoreApi } from '../store/react'

/**
 * Search tasks (⌘F) focuses the sidebar's search field, selecting what's in it, wherever the focus is. With the sidebar
 * collapsed, it shows the sidebar first (a stored change, as its button makes), so the field is there to take the
 * focus. Jump to task (⌘P) does the same: you jump to a task by typing its name and choosing it from the results.
 */
export function useSearchShortcut(): void {
  const store = useGladeStoreApi()
  const focusSearch = (): void => {
    const { uiState, setUiState, focusSearch: focus } = store.getState()
    if (isCollapsed(uiState, Panel.Sidebar)) {
      // Rendered at once, so the field has mounted before it's asked to take the focus.
      flushSync(() => {
        void setUiState(collapsedEntry(Panel.Sidebar, false))
      })
    }
    focus()
  }
  useCommands({ [WindowCommandId.SearchTasks]: focusSearch, [WindowCommandId.JumpToTask]: focusSearch })
}
