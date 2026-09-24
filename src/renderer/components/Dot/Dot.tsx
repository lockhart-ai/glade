import type { TaskIndicator } from '../../../shared/taskIndicator'
import { classNames } from '../classNames'
import styles from './Dot.module.css'

export interface DotProps {
  state: TaskIndicator
  /** Names the dot for screen readers. Without one the dot is decorative, for when nearby text says the same. */
  label?: string
  className?: string
}

/** An 8px dot in a task state's colour: working blue, waiting purple, done slate, error pink. */
export function Dot({ state, label, className }: DotProps): React.JSX.Element {
  const accessibility = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }

  return <span className={classNames(styles.dot, styles[state], className)} data-state={state} {...accessibility} />
}
