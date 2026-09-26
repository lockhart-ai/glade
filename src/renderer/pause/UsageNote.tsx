import { faGaugeHigh } from '@fortawesome/free-solid-svg-icons'
import { useMemo } from 'react'
import { Icon, IconSize } from '../components'
import { useGladeStore } from '../store/react'
import { useNow } from '../task-list/useNow'
import { PauseBanner } from './PauseBanner'
import { pausedTasks } from './pauseModel'
import { usageNoteText } from './usageModel'
import styles from './UsageNote.module.css'

/**
 * The quiet note in the banner's spot while the account is close to a usage limit
 * (`docs/design/html/17-usage-limit.html`): how much of the window is used, and when it resets. Tasks keep working, so
 * it asks nothing of you. Nothing shows while there's no warning.
 */
export function UsageNote(): React.JSX.Element | null {
  const warning = useGladeStore((state) => state.accountStatus.usageWarning)
  const now = useNow()
  if (warning === null) return null
  const { lead, resets } = usageNoteText(warning, now)
  return (
    <div role="status" aria-label="Usage warning" className={styles.note}>
      <span className={styles.icon}>
        <Icon icon={faGaugeHigh} size={IconSize.Medium} />
      </span>
      <span className={styles.text}>
        <span className={styles.lead}>{lead}</span>
        {resets}
      </span>
    </div>
  )
}

/**
 * The one app-wide banner across the top of the window: the paused tasks' banner while any task is paused, or else the
 * usage note while a limit is close. Never both: once tasks pause, their banner takes the note's place.
 */
export function AppBanner(): React.JSX.Element | null {
  const tasks = useGladeStore((state) => state.tasks)
  const paused = useMemo(() => pausedTasks(tasks).length > 0, [tasks])
  return paused ? <PauseBanner /> : <UsageNote />
}
