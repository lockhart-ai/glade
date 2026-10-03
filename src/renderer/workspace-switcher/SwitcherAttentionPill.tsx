import { memo } from 'react'
import { useGladeStore } from '../store/react'
import { needsYouCount, pillText } from './switcherModel'
import styles from './SwitcherAttentionPill.module.css'

/**
 * The closed switcher's own count pill (`docs/design/html/14-workspace-switcher.html`, #472, #480): how many tasks
 * need you (`needsYou`, the same rule everywhere) across every workspace, the open one included — always the same
 * total as the menu bar's icon. Hidden at 0, `9+` past 9. Decorative: the switcher's own `title` says the same thing
 * in words (`switcherTitle`), so it's `aria-hidden`.
 *
 * Reads the count through its own narrow store selector, which returns a number — Zustand only re-renders this
 * component when that number actually changes, so a task update elsewhere that doesn't change the count re-renders
 * neither this pill nor the rest of the sidebar (CLAUDE.md, Performance).
 */
export const SwitcherAttentionPill = memo(function SwitcherAttentionPill(): React.JSX.Element | null {
  const count = useGladeStore((state) => needsYouCount(Object.values(state.tasks), state.workspaces))
  if (count === 0) return null
  return (
    <span className={styles.pill} aria-hidden="true" data-testid="switcher-pill">
      {pillText(count)}
    </span>
  )
})
