import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { ComponentPropsWithRef } from 'react'
import { classNames } from '../classNames'
import { Icon, IconSize } from '../Icon/Icon'
import styles from './Button.module.css'

export enum ButtonVariant {
  /** Blue fill, for the one main action (e.g. Start task). */
  Primary = 'primary',
  /** Raised fill with a strong outline (e.g. Open task, a select trigger). */
  Dark = 'dark',
  /** Transparent with a strong outline (e.g. a labelled Mark done). */
  Ghost = 'ghost',
  /** Pink on a pink tint, for the action that deletes something (e.g. a confirmation's Delete). */
  Danger = 'danger',
  /**
   * A square, borderless icon-only button, the one style for every icon button (e.g. the task header's pin and Mark
   * done, a panel's collapse button). Give it an `icon` and an `aria-label`; as a toggle, `aria-pressed` fills it.
   */
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

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant
  /** Height of a labelled button. Icon buttons are always 30px square. */
  size?: ButtonSize
  /** An icon before the label, or the whole content of an icon button. */
  icon?: IconDefinition
}

/** A real `<button>` (type "button" unless given one). */
export function Button({
  variant = ButtonVariant.Dark,
  size = ButtonSize.Medium,
  icon,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const isIconButton = variant === ButtonVariant.Icon

  return (
    <button
      type={type}
      className={classNames(styles.button, styles[variant], !isIconButton && styles[size], className)}
      {...rest}
    >
      {icon !== undefined && <Icon icon={icon} size={isIconButton ? IconSize.Large : IconSize.Medium} />}
      {children}
    </button>
  )
}
