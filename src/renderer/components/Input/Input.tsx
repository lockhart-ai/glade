import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { InputHTMLAttributes } from 'react'
import { classNames } from '../classNames'
import { Icon, IconSize } from '../Icon/Icon'
import styles from './Input.module.css'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** The field's accessible name. The design shows a placeholder, not a visible label. */
  label: string
  /** An icon before the text, e.g. a magnifier on a search field. */
  icon?: IconDefinition
}

/** A single-line text field on the inset (window background) colour. `className` styles the outer field. */
export function Input({ label, icon, className, type = 'text', ...rest }: InputProps): React.JSX.Element {
  return (
    <span className={classNames(styles.field, className)}>
      {icon !== undefined && <Icon icon={icon} size={IconSize.Medium} />}
      <input type={type} aria-label={label} className={styles.input} {...rest} />
    </span>
  )
}
