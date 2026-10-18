import { memo } from 'react'
import { todoProgress } from '../../shared/todoSummary'
import { useGladeStore } from '../store/react'
import styles from './TodoWaitingBadge.module.css'
import { badgeText, waitingLabel } from './todoWaitingBadgeModel'

export interface TodoWaitingBadgeProps {
  readonly taskId: string
}

/**
 * The Todos tab's own small purple count, after its `3/4`: how many of the task's todos are waiting on you (#680),
 * next to the panel tab bar's "Todos" label. Hidden at 0.
 *
 * Reads the count through its own narrow store selector and is memoised on its props, so a change to anything of the
 * task besides its todos' waiting count — a message, a tool call, another todo's text — never re-renders it, and a
 * change to the waiting count re-renders only this label, not the tab bar or the panel around it (CLAUDE.md,
 * Performance).
 */
export const TodoWaitingBadge = memo(function TodoWaitingBadge({
  taskId,
}: TodoWaitingBadgeProps): React.JSX.Element | null {
  const count = useGladeStore((state) => todoProgress(state.todos[taskId]).waiting)
  if (count === 0) return null
  const label = waitingLabel(count)
  return (
    <span className={styles.badge} role="img" aria-label={label} title={label}>
      {badgeText(count)}
    </span>
  )
})
