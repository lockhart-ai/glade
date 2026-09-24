import type { HTMLAttributes } from 'react'
import { classNames } from '../classNames'
import styles from './Card.module.css'

export enum CardLevel {
  /** A section floating on the window background (sidebar, task card, terminal). */
  TopLevel = 'top-level',
  /** A card inside a top-level card (task header, right panel). Cards nest one level only. */
  Nested = 'nested',
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  level?: CardLevel
}

/** A rounded surface. It sets no padding; each use pads it to suit its content. */
export function Card({ level = CardLevel.TopLevel, className, ...rest }: CardProps): React.JSX.Element {
  return <div className={classNames(styles.card, styles[level], className)} {...rest} />
}
