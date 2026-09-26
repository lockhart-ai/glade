import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faEye } from '@fortawesome/free-regular-svg-icons'
import { faSitemap } from '@fortawesome/free-solid-svg-icons'
import type { TodoSummary } from '../../shared/domain'
import { Icon, IconSize } from '../components'
import { subagentsRunningLabel } from '../subagents/subagentsModel'
import { watchingLabel } from '../watchers/watchersModel'
import { RowTodos } from './RowTodos'
import styles from './TaskRow.module.css'

export interface RowIndicatorsProps {
  /** The agent's todo list in brief; null when it keeps none. */
  todos: TodoSummary | null
  /** How many of its subagents are running. */
  subagents: number
  /** How many of its watchers are live. */
  watching: number
}

/** Whether a row has anything for its indicators line to show, so a row with nothing keeps its two lines. */
export function hasIndicators({ todos, subagents, watching }: RowIndicatorsProps): boolean {
  return todos !== null || subagents > 0 || watching > 0
}

interface CountProps {
  icon: IconDefinition
  count: number
  label: string
}

/** An icon and a count, named in full in its tooltip and to a screen reader. */
function Count({ icon, count, label }: CountProps): React.JSX.Element {
  return (
    <span className={styles.indicator} role="img" aria-label={label} title={label}>
      <Icon icon={icon} size={IconSize.Small} />
      {count}
    </span>
  )
}

/**
 * A task row's third line, under its status, in muted small type: what's going on in the task, always in this order,
 * each only while there's some of it. Its todo progress (`RowTodos`), its running subagents, and its live watchers,
 * each an icon and a count with a tooltip saying what it counts. Nothing at all when there's none of any: the row
 * keeps its two lines.
 */
export function RowIndicators(props: RowIndicatorsProps): React.JSX.Element | null {
  if (!hasIndicators(props)) return null
  const { todos, subagents, watching } = props
  return (
    <span className={styles.indicators} data-indicators="">
      {todos !== null && <RowTodos todos={todos} />}
      {subagents > 0 && <Count icon={faSitemap} count={subagents} label={subagentsRunningLabel(subagents)} />}
      {watching > 0 && <Count icon={faEye} count={watching} label={watchingLabel(watching)} />}
    </span>
  )
}
