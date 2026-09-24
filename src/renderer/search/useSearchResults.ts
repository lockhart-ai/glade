import { useEffect, useState } from 'react'
import type { SearchResult } from '../../shared/search'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** How long typing has to pause before the search runs, so a burst of keystrokes makes one query. */
export const SEARCH_DEBOUNCE_MS = 120

interface Answer {
  readonly results: readonly SearchResult[]
}

/**
 * The results of searching the workspace for `text`, run once typing pauses (`SEARCH_DEBOUNCE_MS`). While a new search
 * runs, the last one's results stay, so the list doesn't flicker as you type; an answer to a search you've since typed
 * past is dropped. Null until the first answer. A search that fails shows a toast and leaves the results as they were.
 * Must be used under a `ToastProvider`.
 */
export function useSearchResults(workspaceId: string, text: string): readonly SearchResult[] | null {
  const searchTasks = useGladeStore((state) => state.searchTasks)
  const toast = useToast()
  const [answer, setAnswer] = useState<Answer | null>(null)

  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      searchTasks(workspaceId, text).then(
        (results) => {
          if (current) setAnswer({ results })
        },
        (error: unknown) => {
          if (current) toast.show({ message: describeFailure(error) })
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [workspaceId, text, searchTasks, toast])

  return answer?.results ?? null
}
