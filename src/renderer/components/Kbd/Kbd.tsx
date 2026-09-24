import type { HTMLAttributes } from 'react'
import { classNames } from '../classNames'
import styles from './Kbd.module.css'

export type KbdProps = HTMLAttributes<HTMLElement>

/** A key or shortcut, like ⌘N, drawn as a keycap. */
export function Kbd({ className, ...rest }: KbdProps): React.JSX.Element {
  return <kbd className={classNames(styles.kbd, className)} {...rest} />
}
