import type { InputHTMLAttributes, ReactNode } from 'react'
import { classNames } from '../classNames'
import styles from './Input.module.css'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** The field's accessible name. The design shows a placeholder, not a visible label. */
  label: string
  /** A decorative icon before the text, e.g. a magnifier on a search field. */
  icon?: ReactNode
}

/** A single-line text field on the inset (window background) colour. `className` styles the outer field. */
export function Input({ label, icon, className, type = 'text', ...rest }: InputProps): React.JSX.Element {
  return (
    <span className={classNames(styles.field, className)}>
      {icon}
      <input type={type} aria-label={label} className={styles.input} {...rest} />
    </span>
  )
}
