import { faChevronDown, faChevronRight, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons'
import { useId, useState } from 'react'
import type { TaskHandoff } from '../../shared/domain'
import { Collapse, Icon, IconSize } from '../components'
import { formatDay } from '../task-header/headerModel'
import { Markdown } from './Markdown'
import styles from './HandoffCard.module.css'

/** What the card's one line says of the note: where it came from, and when it was added. */
export function handoffLine(handoff: TaskHandoff): string {
  return `handoff from earlier notes, added ${formatDay(handoff.addedAt)}`
}

export interface HandoffCardProps {
  readonly handoff: TaskHandoff
}

/**
 * The Backfilled card at the top of a backfilled task's chat (`docs/design/html/25-backfilled.html`): its handoff note,
 * rendered Markdown (raw HTML dropped, nothing loaded), with the date it was added. Its line opens and closes it; it
 * starts open. The note changes only through the control API, never here.
 */
export function HandoffCard({ handoff }: HandoffCardProps): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  return (
    <section aria-label="Backfilled" className={styles.card}>
      <button
        type="button"
        className={styles.line}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setOpen((was) => !was)
        }}
      >
        <span className={styles.icon}>
          <Icon icon={faClockRotateLeft} size={IconSize.Small} />
        </span>
        <span className={styles.label}>Backfilled</span>
        <span className={styles.dot}>·</span>
        <span className={styles.when}>{handoffLine(handoff)}</span>
        <span className={styles.chevron}>
          <Icon icon={open ? faChevronDown : faChevronRight} size={IconSize.Small} />
        </span>
      </button>
      <Collapse open={open}>
        <div id={bodyId} className={styles.body}>
          <Markdown source={handoff.body} />
        </div>
      </Collapse>
    </section>
  )
}
