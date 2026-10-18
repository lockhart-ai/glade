import { memo } from 'react'
import { faEye } from '@fortawesome/free-regular-svg-icons'
import { Count } from '../task-list/RowIndicators'
import { liveWatcherCount, watchingLabel } from '../watchers/watchersModel'
import { useGladeStore } from '../store/react'
import styles from './WatchersBadge.module.css'

export interface WatchersBadgeProps {
  readonly taskId: string
}

/**
 * The Agents tab's own eye and count, after its agent count: how many of the task's own watchers are live (#687),
 * beside the panel tab bar's "Agents" label — the same eye and count the task's row shows in the sidebar
 * (`RowIndicators`), and counting the same (`liveWatcherCount`). Hidden while none is live.
 *
 * Reads the count through its own narrow store selector and is memoised on its props, so a change to anything of the
 * task besides its watchers — a message, a tool call, an agent — never re-renders it, and a watcher starting or
 * ending re-renders only this, not the tab bar or the panel around it (CLAUDE.md, Performance).
 */
export const WatchersBadge = memo(function WatchersBadge({ taskId }: WatchersBadgeProps): React.JSX.Element | null {
  const count = useGladeStore((state) => liveWatcherCount(state.watchers[taskId]))
  if (count === 0) return null
  return (
    <span className={styles.badge}>
      <Count icon={faEye} count={count} label={watchingLabel(count)} />
    </span>
  )
})
