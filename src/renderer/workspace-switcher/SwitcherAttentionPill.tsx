import { memo } from 'react'
import { useGladeStore } from '../store/react'
import { otherWorkspacesNeedsYouCount, pillText } from './switcherModel'
import styles from './SwitcherAttentionPill.module.css'

/**
 * The closed switcher's own count pill (`docs/design/html/14-workspace-switcher.html`, #472): how many tasks need
 * you (`needsYou`, the same rule everywhere) across every workspace other than the open one. Hidden at 0, `9+` past
 * 9. Decorative: the switcher's own `title` says the same thing in words (`switcherTitle`), so it's `aria-hidden`.
 *
 * Reads the count through its own narrow store selector, which returns a number — Zustand only re-renders this
 * component when that number actually changes, so a task update elsewhere that doesn't change the count, or one in
 * the open workspace (which never counts), re-renders neither this pill nor the rest of the sidebar (CLAUDE.md,
 * Performance).
 */
export const SwitcherAttentionPill = memo(function SwitcherAttentionPill(): React.JSX.Element | null {
  const count = useGladeStore((state) =>
    otherWorkspacesNeedsYouCount(Object.values(state.tasks), state.selectedWorkspaceId),
  )
  if (count === 0) return null
  return (
    <span className={styles.pill} aria-hidden="true" data-testid="switcher-pill">
      {pillText(count)}
    </span>
  )
})
