import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faEye } from '@fortawesome/free-regular-svg-icons'
import { faSitemap } from '@fortawesome/free-solid-svg-icons'
import type { TodoSummary } from '../../shared/domain'
import { Icon, IconSize } from '../components'
import { subagentsLabel } from '../subagents/subagentsModel'
import { watchingLabel } from '../watchers/watchersModel'
import { RowTodos } from './RowTodos'
import styles from './TaskRow.module.css'

export interface RowIndicatorsProps {
  /** The agent's todo list in brief; null when it keeps none. */
  todos: TodoSummary | null
  /** How many of its subagents are running now. */
  subagentsRunning: number
  /** How many of its subagents have ended their own turn but still have something they started alive (#579). */
  subagentsWaiting: number
  /** How many of its watchers are live. */
  watching: number
}

/** Whether a row has anything for its indicators line to show, so a row with nothing keeps its two lines. */
export function hasIndicators({ todos, subagentsRunning, subagentsWaiting, watching }: RowIndicatorsProps): boolean {
  return todos !== null || subagentsRunning + subagentsWaiting > 0 || watching > 0
}

interface CountProps {
  icon: IconDefinition
  count: number
  label: string
}

/**
 * An icon and a count, named in full in its tooltip and to a screen reader. Shared with the right panel's tabs: the
 * Agents tab shows the task's live watchers with it, the same eye and count this row shows (#687).
 */
export function Count({ icon, count, label }: CountProps): React.JSX.Element {
  return (
    <span className={styles.indicator} role="img" aria-label={label} title={label}>
      <Icon icon={icon} size={IconSize.Small} />
      {count}
    </span>
  )
}

/**
 * A task row's third line, under its status, in muted small type: what's going on in the task, always in this order,
 * each only while there's some of it. Its todo progress (`RowTodos`), its subagents (running and waiting on
 * something they started counted together, #579), and its live watchers, each an icon and a count with a tooltip
 * saying what it counts. Nothing at all when there's none of any: the row keeps its two lines.
 */
export function RowIndicators(props: RowIndicatorsProps): React.JSX.Element | null {
  if (!hasIndicators(props)) return null
  const { todos, subagentsRunning, subagentsWaiting, watching } = props
  const subagentsTotal = subagentsRunning + subagentsWaiting
  return (
    <span className={styles.indicators} data-indicators="">
      {todos !== null && <RowTodos todos={todos} />}
      {subagentsTotal > 0 && (
        <Count
          icon={faSitemap}
          count={subagentsTotal}
          label={subagentsLabel({ running: subagentsRunning, waiting: subagentsWaiting })}
        />
      )}
      {watching > 0 && <Count icon={faEye} count={watching} label={watchingLabel(watching)} />}
    </span>
  )
}
