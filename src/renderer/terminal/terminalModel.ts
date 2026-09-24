// The terminal's logic, apart from React and xterm.js: which tab shows, its shortcuts, and which output a window
// already has.
import { UiStateKey } from '../../shared/domain'
import type { TerminalTab } from '../../shared/terminal'
import type { UiStateValues } from '../store/state'

/** The tab the bottom bar shows: the one last picked, or the first while that one's gone (or none was). */
export function activeTerminalTab(tabs: readonly TerminalTab[], uiState: UiStateValues): TerminalTab | undefined {
  const picked = uiState[UiStateKey.TerminalTab]
  return tabs.find((tab) => tab.id === picked) ?? tabs[0]
}

/** What a terminal shortcut does (docs/keymap.md). */
export enum TerminalShortcut {
  /** ⌃`: focus the terminal, wherever the focus is. */
  Focus = 'focus',
  /** ⌘T: a new terminal tab, wherever the focus is. */
  NewTab = 'new_tab',
  /** ⌃⇥, in the terminal. */
  NextTab = 'next_tab',
  /** ⌃⇧⇥, in the terminal. */
  PreviousTab = 'previous_tab',
  /** ⌘K, in the terminal. */
  Clear = 'clear',
  /** ⌘W, in the terminal: close its tab. */
  Close = 'close',
}

/** The parts of a key press the terminal's shortcuts read. */
export interface ShortcutKeys {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  /** The physical key, e.g. `KeyT`. */
  readonly code: string
}

/**
 * The terminal shortcut a key press is, or null. It reads the physical key (`code`), as the other ⌘ shortcuts with a
 * letter do. ⌃C isn't here: it's a key the terminal itself sends, as any terminal does, and SIGINT follows.
 */
export function terminalShortcut({ metaKey, ctrlKey, altKey, shiftKey, code }: ShortcutKeys): TerminalShortcut | null {
  if (altKey) return null
  if (ctrlKey && !metaKey) {
    if (code === 'Tab') return shiftKey ? TerminalShortcut.PreviousTab : TerminalShortcut.NextTab
    return code === 'Backquote' && !shiftKey ? TerminalShortcut.Focus : null
  }
  if (!metaKey || ctrlKey || shiftKey) return null
  switch (code) {
    case 'KeyT':
      return TerminalShortcut.NewTab
    case 'KeyK':
      return TerminalShortcut.Clear
    case 'KeyW':
      return TerminalShortcut.Close
    default:
      return null
  }
}

/**
 * Whether the terminal leaves a key press to the app rather than sending it to its shell: every ⌘ shortcut (a Mac
 * terminal sends none of them) and the terminal's own ⌃ shortcuts.
 */
export function isAppKey(event: ShortcutKeys): boolean {
  return event.metaKey || terminalShortcut(event) !== null
}

/** The tab `step` tabs on from `activeId`, going round: ⌃⇥ is 1, ⌃⇧⇥ is -1. */
export function cycledTab(ids: readonly string[], activeId: string, step: 1 | -1): string | undefined {
  const index = ids.indexOf(activeId)
  if (index === -1) return ids[0]
  return ids[(index + step + ids.length) % ids.length]
}

/**
 * The part of a `terminal.output` event's data that a window doesn't have yet, having shown the tab's output up to
 * `end`: all of it when it starts at or after `end`, none when it ends before it.
 */
export function unseenOutput(offset: number, data: string, end: number): string {
  return offset >= end ? data : data.slice(end - offset)
}

/**
 * A command to put at the prompt (Run again in terminal), without the line break that would run it: you look it over,
 * then press ↵.
 */
export function commandToPaste(command: string): string {
  return command.replace(/\s+$/, '')
}
