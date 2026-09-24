import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import { Icon, IconSize, Menu, MenuAnchorKind, MenuEntryKind, Placement, type MenuEntry } from '../components'
import styles from './InputBar.module.css'

/** One choice in a setting picker. */
export interface SettingOption {
  readonly id: string
  readonly name: string
}

export interface SettingPickerProps {
  /** The setting's name, e.g. "Model". */
  readonly label: string
  /** What the button shows as the current value. */
  readonly value: string
  readonly options: readonly SettingOption[]
  /** The chosen option's id, which the menu checks; none is checked when it isn't one of the options. */
  readonly selectedId: string
  /** Called with the option chosen from the menu. */
  readonly onChoose: (id: string) => void
}

/**
 * One of the input bar's settings: a "Label Value ⌄" button that opens a menu of its options above it, with the
 * current one checked.
 */
export function SettingPicker({ label, value, options, selectedId, onChoose }: SettingPickerProps): React.JSX.Element {
  // The button, while its menu is open.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const open = anchor !== null

  const entries: MenuEntry[] = options.map((option) => ({
    kind: MenuEntryKind.Item,
    label: option.name,
    checked: option.id === selectedId,
    onSelect: () => {
      onChoose(option.id)
    },
  }))

  return (
    <>
      <button
        type="button"
        aria-label={`${label}: ${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={styles.setting}
        onClick={(event) => {
          setAnchor(event.currentTarget)
        }}
      >
        <span className={styles.settingLabel}>{label}</span>
        <span className={styles.settingValue}>{value}</span>
        <Icon icon={faChevronDown} size={IconSize.Small} />
      </button>
      <Menu
        label={label}
        entries={entries}
        anchor={{ kind: MenuAnchorKind.Element, element: anchor, placement: Placement.TopStart }}
        open={open}
        onClose={() => {
          setAnchor(null)
        }}
      />
    </>
  )
}
