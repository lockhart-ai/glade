import { useState, type KeyboardEvent } from 'react'
import {
  bindingProblem,
  chordFromEvent,
  commandDefinition,
  DEFAULT_KEYMAP,
  describeBindingProblem,
  FIXED_REASONS,
  formatBinding,
  KEYMAP_LAYOUT,
  withBinding,
  withDefault,
  type ShortcutId,
  type KeymapKey,
  type KeymapRow,
} from '../../shared/keymap'
import { useKeymap } from '../commands/hooks'
import { Kbd } from '../components'
import { classNames } from '../components/classNames'
import { useGladeStore } from '../store/react'
import styles from './SettingsDialog.module.css'

/** What the keycap being recorded says until you press the new keys. */
export const RECORDING_PROMPT = 'Press keys…'

/** A row's keycap that's being recorded, or showing why the keys you pressed couldn't be its binding. */
interface KeyFocus {
  /** The row, by its action. */
  readonly row: string
  readonly command: ShortcutId
}

/** The name a keycap goes by: its command's, or the row's for a row of one command (the right panel's tabs split in two). */
function keyName(row: KeymapRow, key: KeymapKey): string {
  return row.keys.length > 1 ? commandDefinition(key.command).label : row.action
}

/**
 * Settings › Keyboard: every shortcut, grouped as `22-keymap.png` groups them. Click a keycap and press the new keys to
 * rebind it; Esc (or clicking away) keeps the old ones. Keys that are reserved, or that another command already has
 * where this one applies, are refused with the reason under the row. A rebound shortcut has Reset beside it, which
 * puts back its default. The few fixed ones (the menus' own keys, ⌘W) aren't buttons, and say why when hovered.
 */
export function KeyboardSection(): React.JSX.Element {
  const keymap = useKeymap()
  const overrides = useGladeStore((state) => state.settings.keyBindings)
  const updateSettings = useGladeStore((state) => state.updateSettings)
  const [recording, setRecording] = useState<KeyFocus | null>(null)
  const [problem, setProblem] = useState<(KeyFocus & { readonly message: string }) | null>(null)

  const record = (focus: KeyFocus, event: KeyboardEvent<HTMLButtonElement>): void => {
    // The keys are the new binding, not a shortcut: nothing else hears them, the window's dispatcher and Esc closing
    // Settings included.
    event.preventDefault()
    event.stopPropagation()
    const chord = chordFromEvent(event)
    if (chord === null) return
    setRecording(null)
    if (chord.key === 'Escape' && !chord.meta && !chord.ctrl && !chord.alt && !chord.shift) return
    const found = bindingProblem(focus.command, chord, keymap)
    if (found !== null) {
      setProblem({ ...focus, message: describeBindingProblem(chord, found) })
      return
    }
    setProblem(null)
    void updateSettings({ keyBindings: withBinding(overrides, focus.command, chord) })
  }

  const reset = (command: ShortcutId): void => {
    setProblem(null)
    void updateSettings({ keyBindings: withDefault(overrides, command) })
  }

  const keycap = (row: KeymapRow, key: KeymapKey): React.JSX.Element => {
    const keys = formatBinding(key.command, keymap, key.digits)
    const name = keyName(row, key)
    const { fixed } = commandDefinition(key.command)
    if (fixed !== undefined)
      return (
        <Kbd key={key.command} title={FIXED_REASONS[fixed]}>
          {keys}
        </Kbd>
      )
    const focus: KeyFocus = { row: row.action, command: key.command }
    const active = recording?.row === row.action && recording.command === key.command
    return (
      <button
        key={key.command}
        type="button"
        className={styles.keycap}
        aria-label={active ? `${name}: press the new keys` : `${name}: ${keys}`}
        aria-pressed={active}
        title="Click, then press the new keys"
        onClick={() => {
          setProblem(null)
          setRecording(active ? null : focus)
        }}
        onKeyDown={(event) => {
          if (active) record(focus, event)
        }}
        onBlur={() => {
          if (active) setRecording(null)
        }}
      >
        <Kbd className={classNames(active && styles.recording)}>{active ? RECORDING_PROMPT : keys}</Kbd>
      </button>
    )
  }

  return (
    <>
      <p className={styles.intro}>
        The keyboard shortcuts. Click one and press the keys to change it. Menus show them too.
      </p>
      {KEYMAP_LAYOUT.map((group) => (
        <section key={group.area} className={styles.keyGroup} aria-label={group.area}>
          <h3 className={styles.keyArea}>{group.area}</h3>
          {group.rows.map((row) => {
            const rebound = [...new Set(row.keys.map(({ command }) => command))].filter(
              (command) => overrides[command] !== undefined,
            )
            const message = problem?.row === row.action ? problem.message : null
            return (
              <div key={row.action} className={styles.keyRow}>
                <div className={styles.keyLine}>
                  <span>{row.action}</span>
                  <span className={styles.keys}>
                    {rebound.map((command) => (
                      <button
                        key={command}
                        type="button"
                        className={styles.resetKey}
                        aria-label={`Reset ${keyName(row, { command })} to ${formatBinding(command, DEFAULT_KEYMAP)}`}
                        onClick={() => {
                          reset(command)
                        }}
                      >
                        Reset
                      </button>
                    ))}
                    {row.keys.map((key) => keycap(row, key))}
                  </span>
                </div>
                {message !== null && (
                  <p role="alert" className={styles.keyProblem}>
                    {message}
                  </p>
                )}
              </div>
            )
          })}
        </section>
      ))}
    </>
  )
}
