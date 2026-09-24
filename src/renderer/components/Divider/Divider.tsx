import type { HTMLAttributes } from 'react'
import { classNames } from '../classNames'
import styles from './Divider.module.css'

export type DividerProps = HTMLAttributes<HTMLHRElement>

/** A 1px horizontal rule in the nested-card border colour. */
export function Divider({ className, ...rest }: DividerProps): React.JSX.Element {
  return <hr className={classNames(styles.divider, className)} {...rest} />
}
