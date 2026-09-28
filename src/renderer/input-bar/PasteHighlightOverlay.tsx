import { forwardRef } from 'react'
import { pasteTokenRanges } from '../../shared/pastedContent'
import styles from './PasteHighlightOverlay.module.css'

export interface PasteHighlightOverlayProps {
  /** The field's text, exactly as it is: mirrored here so the two wrap identically. */
  readonly text: string
}

/** A run of the mirrored text: plain, or one of a pasted block's tokens, to highlight. */
interface OverlayRun {
  readonly highlighted: boolean
  readonly text: string
}

/** `text` split at each token's range, in order, so a token becomes its own (highlighted) run. */
function overlayRuns(text: string): OverlayRun[] {
  const runs: OverlayRun[] = []
  let at = 0
  for (const { start, end } of pasteTokenRanges(text)) {
    if (start > at) runs.push({ highlighted: false, text: text.slice(at, start) })
    runs.push({ highlighted: true, text: text.slice(start, end) })
    at = end
  }
  if (at < text.length || runs.length === 0) runs.push({ highlighted: false, text: text.slice(at) })
  return runs
}

/**
 * Highlights each pasted block's token in the input field (#363), styling only: a div behind the field, mirroring its
 * font, padding and wrapping exactly and holding the same text, with each token's range wrapped in a tinted `<mark>`.
 * The field's own background is transparent, so the tint shows through it; the field's own text paints over the
 * mirror's, which is never shown (its colour is transparent) so nothing doubles up. The field stays the one true copy
 * of the text — the caret, the selection, IME composition and undo never touch this: `aria-hidden`, and never in the
 * tab order. `InputBar` keeps its scroll position in step with the field's (on scroll, on every change, and on
 * resize), since this is a plain `div`, not a second scrollable field.
 */
export const PasteHighlightOverlay = forwardRef<HTMLDivElement, PasteHighlightOverlayProps>(
  function PasteHighlightOverlay({ text }, ref) {
    return (
      <div ref={ref} aria-hidden="true" data-testid="paste-highlight-overlay" className={styles.overlay}>
        {overlayRuns(text).map((run, index) =>
          run.highlighted ? (
            <mark key={index} className={styles.token}>
              {run.text}
            </mark>
          ) : (
            // A plain run: text, not markup, same as the field's own value.
            run.text
          ),
        )}
      </div>
    )
  },
)
