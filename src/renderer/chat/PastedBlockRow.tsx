import { faChevronDown, faChevronRight, faPaste } from '@fortawesome/free-solid-svg-icons'
import { useId, useState } from 'react'
import type { PastedBlock } from '../../shared/domain'
import { pastedLineCount } from '../../shared/pastedContent'
import { Collapse, Icon, IconSize } from '../components'
import { LinkedText } from '../links'
import styles from './PastedBlockRow.module.css'

/** "Pasted text · 42 lines", singular for one line. */
export function pastedBlockLabel(block: PastedBlock): string {
  const lines = pastedLineCount(block.text)
  return `Pasted text · ${String(lines)} line${lines === 1 ? '' : 's'}`
}

export interface PastedBlockRowProps {
  readonly block: PastedBlock
  /** What the sidebar search marks (`useSearchHighlight`); a match inside opens the row so you can see it. */
  readonly highlight: RegExp | null
}

/**
 * A block of text pasted into your message, in the chat (#363): collapsed to its line count, expanding in place to
 * the pasted text itself (never rendered as Markdown: it's shown verbatim, as a code block is). Starts collapsed,
 * unless the sidebar search's match is inside it.
 */
export function PastedBlockRow({ block, highlight }: PastedBlockRowProps): React.JSX.Element {
  // A fresh copy to test: `highlight` is a shared, stateful global regex (its `lastIndex` moves as it's used
  // elsewhere, e.g. by `LinkedText` below), and testing it directly would leave it part-way through for them.
  const matchedInside = highlight !== null && new RegExp(highlight).test(block.text)
  // Null until you toggle it by hand: until then, it follows whether the search's match is inside (reactively, as
  // the search text changes), and your own choice always wins once you've made one.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? matchedInside
  const bodyId = useId()
  return (
    <section aria-label={pastedBlockLabel(block)} className={styles.row}>
      <button
        type="button"
        className={styles.line}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setToggled(!open)
        }}
      >
        <span className={styles.icon}>
          <Icon icon={faPaste} size={IconSize.Small} />
        </span>
        <span className={styles.label}>{pastedBlockLabel(block)}</span>
        <span className={styles.chevron}>
          <Icon icon={open ? faChevronDown : faChevronRight} size={IconSize.Small} />
        </span>
      </button>
      <Collapse open={open}>
        <pre id={bodyId} className={styles.body}>
          <code>
            <LinkedText text={block.text} pattern={highlight} />
          </code>
        </pre>
      </Collapse>
    </section>
  )
}
