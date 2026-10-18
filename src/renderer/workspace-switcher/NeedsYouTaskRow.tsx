import { memo } from 'react'
import { useGladeStore } from '../store/react'
import { Age } from '../todos/tiles/Age'
import { useNow } from '../task-list/useNow'
import { BadgeTone, needsYouTaskTitle, needsYouWhy } from './switcherModel'
import { BadgeSize, WorkspaceBadge } from './WorkspaceBadge'
import styles from './WorkspaceSwitcher.module.css'

export interface NeedsYouTaskRowProps {
  /** Stable across renders (it never changes which task a row stands for), so `memo` below can tell a sibling
   * task's change from its own. */
  taskId: string
  /** The task's workspace's name, for the row's badge. */
  workspaceName: string
  tone: BadgeTone
}

/**
 * The row's purple why line: what the task waits on you for. Reads its own task and keeps its own clock (`useNow`),
 * so the task changing or a tick of the clock re-renders only this span, never the row around it (CLAUDE.md,
 * Performance).
 */
function WhyLine({ taskId }: { taskId: string }): React.JSX.Element | null {
  const task = useGladeStore((state) => state.tasks[taskId])
  const now = useNow()
  if (task === undefined) return null
  return <span className={styles.needsYouWhy}>{needsYouWhy(task, now)}</span>
}

/**
 * A task that needs you, in the switcher's Needs-you section (`docs/design/html/14-workspace-switcher-tasks.html`,
 * #681): the workspace's initial badge, the title, the purple why line and the time, nothing else. Reads its own
 * title and `updatedAt` through its own narrow store selectors, the same way the Broadcast modal's `RecipientRow`
 * does, so a task changing elsewhere never renders it, even while its siblings' entries are rebuilt around it
 * (CLAUDE.md, Performance). Renders nothing for a task that's gone (deleted since the menu opened).
 */
export const NeedsYouTaskRow = memo(function NeedsYouTaskRow({
  taskId,
  workspaceName,
  tone,
}: NeedsYouTaskRowProps): React.JSX.Element | null {
  const title = useGladeStore((state) => state.tasks[taskId]?.title)
  const updatedAt = useGladeStore((state) => state.tasks[taskId]?.updatedAt)
  if (title === undefined || updatedAt === undefined) return null
  return (
    <span className={styles.needsYouLine}>
      <WorkspaceBadge name={workspaceName} tone={tone} size={BadgeSize.Small} />
      <span className={styles.needsYouText}>
        <span className={styles.needsYouTitle}>{needsYouTaskTitle(title)}</span>
        <WhyLine taskId={taskId} />
      </span>
      <span className={styles.needsYouTime}>
        <Age at={updatedAt} />
      </span>
    </span>
  )
})
