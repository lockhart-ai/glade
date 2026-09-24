import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { useRef, type KeyboardEvent } from 'react'
import { classNames } from '../classNames'
import { Icon, IconSize } from '../Icon/Icon'
import styles from './Segmented.module.css'

/** One choice in a segmented control. */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** An icon before the label. */
  icon?: IconDefinition
}

export interface SegmentedProps<T extends string> {
  /** The group's accessible name, e.g. "Effort". */
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}

/** Keys that move the selection, and which way. */
const STEPS: Readonly<Partial<Record<string, number>>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

/**
 * A row of mutually exclusive choices, like Effort (Low / Medium / High / Max) in Settings. It is a radio group:
 * one tab stop on the chosen option, and the arrow keys move the choice, wrapping at the ends.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: SegmentedProps<T>): React.JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  // If nothing is chosen yet, the first option takes the tab stop so the group stays reachable by keyboard.
  const tabStop = Math.max(
    options.findIndex((option) => option.value === value),
    0,
  )

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = STEPS[event.key]
    if (step === undefined) return

    event.preventDefault()
    const next = (index + step + options.length) % options.length
    const option = options[next]
    // Always defined: the index is taken modulo the number of options, and this option received the key press.
    if (option === undefined) return
    onChange(option.value)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={classNames(styles.group, className)}
    >
      {options.map((option, index) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(button) => {
              buttons.current[index] = button
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            className={styles.option}
            onClick={() => {
              onChange(option.value)
            }}
            onKeyDown={(event) => {
              handleKeyDown(event, index)
            }}
          >
            {option.icon !== undefined && <Icon icon={option.icon} size={IconSize.Medium} />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
