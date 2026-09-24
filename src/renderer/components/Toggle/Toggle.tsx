import type { ButtonHTMLAttributes } from 'react'
import { classNames } from '../classNames'
import styles from './Toggle.module.css'

export interface ToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'type' | 'role' | 'aria-checked' | 'children'
> {
  checked: boolean
  onChange: (checked: boolean) => void
  /** The switch's accessible name. Settings rows show the same words as visible text beside it. */
  label: string
}

/** An on/off switch: a `<button role="switch">` that flips `checked` when clicked or pressed with Space or Enter. */
export function Toggle({ checked, onChange, label, className, ...rest }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={classNames(styles.toggle, className)}
      onClick={() => {
        onChange(!checked)
      }}
      {...rest}
    >
      <span className={styles.thumb} />
    </button>
  )
}
