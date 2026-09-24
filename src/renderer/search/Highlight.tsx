import { useMemo } from 'react'
import { highlightParts, highlightPattern, type TextPart } from '../../shared/search'
import { useGladeStore } from '../store/react'
import styles from './Highlight.module.css'

export interface MarkedProps {
  /** The text, in parts: the matches are marked. */
  readonly parts: readonly TextPart[]
}

/** Text with its search matches marked (`<mark>`). Each part is text, never markup. */
export function Marked({ parts }: MarkedProps): React.JSX.Element {
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className={styles.mark}>
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  )
}

export interface HighlightedProps {
  readonly text: string
  /** What to mark, from `highlightPattern`; null marks nothing. */
  readonly pattern: RegExp | null
}

/** Text with what `pattern` matches in it marked. */
export function Highlighted({ text, pattern }: HighlightedProps): React.JSX.Element {
  const parts = useMemo(() => highlightParts(text, pattern), [text, pattern])
  return <Marked parts={parts} />
}

/**
 * What the sidebar's search matches, for highlighting in the task header and chat: null while there's no search. The
 * highlight stays until the search changes or is cleared, whichever task you open.
 */
export function useSearchHighlight(): RegExp | null {
  const text = useGladeStore((state) => state.searchText)
  return useMemo(() => highlightPattern(text), [text])
}
