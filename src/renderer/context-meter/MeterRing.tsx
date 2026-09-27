import { classNames } from '../components/classNames'
import styles from './MeterRing.module.css'

/** The ring's radius, in the 16px icon's units. */
const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface MeterRingProps {
  /** How much of the ring is filled, from 0 to 1; null for an empty ring, with no arc at all. */
  readonly fraction: number | null
  /** Whether it's near a limit or threshold: the arc turns purple. */
  readonly near?: boolean
}

/**
 * The small ring the context meter and the usage meter share (`docs/design/html/task-workspace.html`,
 * `30-usage-meter.html`): a track, and a blue arc from the top that turns purple when `near`.
 */
export function MeterRing({ fraction, near = false }: MeterRingProps): React.JSX.Element {
  return (
    <svg className={styles.ring} width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle className={styles.track} cx="8" cy="8" r={RADIUS} />
      {fraction !== null && (
        <circle
          className={classNames(styles.arc, near && styles.near)}
          cx="8"
          cy="8"
          r={RADIUS}
          strokeDasharray={`${(Math.min(1, Math.max(0, fraction)) * CIRCUMFERENCE).toFixed(1)} ${CIRCUMFERENCE.toFixed(1)}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}
