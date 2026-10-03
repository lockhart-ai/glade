import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import { Icon, IconSize, Menu, MenuAnchorKind, MenuEntryKind, Placement, type MenuEntry } from '../components'
import { classNames } from '../components/classNames'
import styles from './SettingsDialog.module.css'

/** One thing a compact select offers: the value it stands for, and how it reads. */
export interface SettingSelectOption<Value extends string> {
  readonly value: Value
  readonly label: string
}

export interface SettingSelectProps<Value extends string> {
  /** What the select sets, which its accessible name starts with: "Sketchpad: Style", "Access to ~/.nvm". */
  name: string
  /** The menu's accessible name. */
  menuLabel: string
  options: readonly SettingSelectOption<Value>[]
  /** The option chosen; one that isn't offered shows as it is. */
  value: Value
  disabled?: boolean
  onChoose: (value: Value) => void
}

/**
 * Settings' compact select (`docs/design/html/21-settings-plugins.html`): a button naming the option chosen, which
 * opens a menu of the options with it checked, as the model picker does. A plugin's `select` settings use it, and a
 * granted folder's access in the sandbox lists.
 */
export function SettingSelect<Value extends string>({
  name,
  menuLabel,
  options,
  value,
  disabled = false,
  onChoose,
}: SettingSelectProps<Value>): React.JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const chosen = options.find((option) => option.value === value)?.label ?? value
  const entries: MenuEntry[] = options.map((option) => ({
    kind: MenuEntryKind.Item,
    label: option.label,
    checked: option.value === value,
    onSelect: () => {
      onChoose(option.value)
    },
  }))
  return (
    <>
      <button
        type="button"
        aria-label={`${name}: ${chosen}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        disabled={disabled}
        className={classNames(styles.select, styles.pluginSelect)}
        onClick={(event) => {
          setAnchor(event.currentTarget)
        }}
      >
        {chosen}
        <Icon icon={faChevronDown} size={IconSize.Small} />
      </button>
      <Menu
        label={menuLabel}
        entries={entries}
        anchor={{ kind: MenuAnchorKind.Element, element: anchor, placement: Placement.BottomEnd }}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
      />
    </>
  )
}
