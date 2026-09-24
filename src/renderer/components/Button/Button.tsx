import type { ButtonHTMLAttributes } from 'react'
import { classNames } from '../classNames'
import styles from './Button.module.css'

export enum ButtonVariant {
  /** Blue fill, for the one main action (e.g. Start task). */
  Primary = 'primary',
  /** Raised fill with a strong outline (e.g. Open task, a select trigger). */
  Dark = 'dark',
  /** Transparent with a strong outline (e.g. Mark done). */
  Ghost = 'ghost',
  /** A square, borderless icon-only button (e.g. Pin task). Give it an `aria-label`. */
  Icon = 'icon',
}

export enum ButtonSize {
  /** 30px tall. */
  Small = 'small',
  /** 34px tall. */
  Medium = 'medium',
  /** 42px tall, for a lone call to action. */
  Large = 'large',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** Height of a labelled button. Icon buttons are always 30px square. */
  size?: ButtonSize
}

/** A real `<button>` (type "button" unless given one). Put an icon before the label as a child. */
export function Button({
  variant = ButtonVariant.Dark,
  size = ButtonSize.Medium,
  type = 'button',
  className,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={classNames(styles.button, styles[variant], variant !== ButtonVariant.Icon && styles[size], className)}
      {...rest}
    />
  )
}
