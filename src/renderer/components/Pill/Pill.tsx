import type { HTMLAttributes } from 'react'
import type { TaskIndicator } from '../../../shared/taskIndicator'
import { classNames } from '../classNames'
import { Dot } from '../Dot/Dot'
import styles from './Pill.module.css'

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  /** Sets the pill's tint and its dot's colour. */
  indicator: TaskIndicator
}

/** A rounded status label with a state dot, like "Active · waiting on you" in the task header. */
export function Pill({ indicator, className, children, ...rest }: PillProps): React.JSX.Element {
  return (
    <span className={classNames(styles.pill, styles[indicator], className)} {...rest}>
      <Dot state={indicator} />
      {children}
    </span>
  )
}
