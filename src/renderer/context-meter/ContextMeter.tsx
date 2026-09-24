import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import styles from './ContextMeter.module.css'
import { contextReading } from './format'

/** The ring's radius, in the 16px icon's units. */
const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface ContextMeterViewProps {
  readonly usedTokens: number
  readonly windowTokens: number
}

/** How full the context is: a small ring and "38% · 76k / 200k". Read-only; the popover and compaction come in P3. */
export function ContextMeterView({ usedTokens, windowTokens }: ContextMeterViewProps): React.JSX.Element {
  const reading = contextReading(usedTokens, windowTokens)
  const percent = `${String(reading.percent)}%`
  const amount = `${reading.used} / ${reading.window}`
  const arc = (reading.fraction * CIRCUMFERENCE).toFixed(1)
  return (
    <span
      className={styles.meter}
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={reading.percent}
      aria-valuetext={`${percent} · ${amount}`}
      title="Context used"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle className={styles.track} cx="8" cy="8" r={RADIUS} />
        <circle
          className={styles.arc}
          cx="8"
          cy="8"
          r={RADIUS}
          strokeDasharray={`${arc} ${CIRCUMFERENCE.toFixed(1)}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span>
        <span className={styles.percent}>{percent}</span> · {amount}
      </span>
    </span>
  )
}

/** The selected task's context meter, or nothing when no task is selected. */
export function ContextMeter(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  if (task === undefined) return null
  return <ContextMeterView usedTokens={task.contextUsedTokens} windowTokens={task.contextWindowTokens} />
}
