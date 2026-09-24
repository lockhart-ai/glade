import type { TextareaHTMLAttributes } from 'react'
import { classNames } from '../classNames'
import styles from './Textarea.module.css'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** The field's accessible name. The design shows a placeholder, not a visible label. */
  label: string
}

/** A multi-line text field on the inset (window background) colour, in the chat type size. */
export function Textarea({ label, className, rows = 2, ...rest }: TextareaProps): React.JSX.Element {
  return <textarea aria-label={label} rows={rows} className={classNames(styles.textarea, className)} {...rest} />
}
