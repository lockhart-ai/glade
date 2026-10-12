import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { memo } from 'react'
import { TaskIndicator } from '../../shared/taskIndicator'
import { Dot, Icon, IconSize } from '../components'
import { useGladeStore } from '../store/react'
import { Age } from '../todos/tiles/Age'
import { waitingTaskTitle } from './switcherModel'
import styles from './WorkspaceSwitcher.module.css'

export interface WaitingTaskRowProps {
  /** Stable across renders (it never changes which task a row stands for), so `memo` below can tell a sibling
   * task's change from its own. */
  taskId: string
}

/**
 * A workspace's waiting task, nested under it in the switcher (`docs/design/html/14-workspace-switcher-tasks.html`,
 * #610): a purple dot, the title (ellipsised when long) and the time, nothing else. Reads its own title and
 * `updatedAt` through its own narrow store selector, the same way the Broadcast modal's `RecipientRow` does, so a
 * task changing elsewhere never renders it, even while its siblings' entries are rebuilt around it (CLAUDE.md,
 * Performance). Renders nothing for a task that's gone (deleted since the menu opened).
 */
export const WaitingTaskRow = memo(function WaitingTaskRow({ taskId }: WaitingTaskRowProps): React.JSX.Element | null {
  const title = useGladeStore((state) => state.tasks[taskId]?.title)
  const updatedAt = useGladeStore((state) => state.tasks[taskId]?.updatedAt)
  if (title === undefined || updatedAt === undefined) return null
  return (
    <span className={styles.waitingLine}>
      <Dot state={TaskIndicator.Waiting} />
      <span className={styles.waitingTitle}>{waitingTaskTitle(title)}</span>
      <span className={styles.waitingTime}>
        <Age at={updatedAt} />
      </span>
    </span>
  )
})

export interface MoreTasksRowProps {
  /** How many more of the workspace's waiting tasks aren't shown. */
  count: number
  workspaceName: string
}

/** The dimmed "+N more in <workspace>" row past `WAITING_TASKS_SHOWN` (#610): no dot, a chevron at the right. */
export function MoreTasksRow({ count, workspaceName }: MoreTasksRowProps): React.JSX.Element {
  return (
    <span className={styles.waitingLine}>
      <span className={styles.more}>{`+${String(count)} more in ${workspaceName}`}</span>
      <Icon icon={faChevronRight} size={IconSize.Small} className={styles.moreChevron} />
    </span>
  )
}
