// The terminal's logic, apart from React and xterm.js: which tab shows, which keys it leaves to the app, and which
// output a window already has.
import { WindowCommandId } from '../../shared/commands'
import { UiStateKey } from '../../shared/domain'
import { chordFromEvent, COMMANDS, KeyScope, matchCommand, type Keymap, type KeyPress } from '../../shared/keymap'
import type { TerminalTab } from '../../shared/terminal'
import type { UiStateValues } from '../store/state'

/** The tab the bottom bar shows: the one last picked, or the first while that one's gone (or none was). */
export function activeTerminalTab(tabs: readonly TerminalTab[], uiState: UiStateValues): TerminalTab | undefined {
  const picked = uiState[UiStateKey.TerminalTab]
  return tabs.find((tab) => tab.id === picked) ?? tabs[0]
}

/** The scopes of the shortcuts that reach the app with the focus in the terminal, rather than its shell. */
const APP_SCOPES: readonly KeyScope[] = [KeyScope.MenuBar, KeyScope.Window, KeyScope.Terminal]

/**
 * Whether the terminal leaves a key press to the app rather than sending it to its shell: every ⌘ key (a Mac terminal
 * sends none of them), and any other key bound to a command that works in the terminal (⌃`, ⌃⇥…), as the keymap now
 * binds it. Kill process's ⌃C is the shell's: the terminal sends it, and SIGINT follows.
 */
export function isAppKey(keymap: Keymap, event: KeyPress): boolean {
  if (event.metaKey) return true
  const pressed = chordFromEvent(event)
  if (pressed === null) return false
  return COMMANDS.some(
    (definition) =>
      definition.id !== WindowCommandId.KillProcess &&
      APP_SCOPES.includes(definition.scope) &&
      matchCommand(definition, keymap[definition.id], pressed) !== null,
  )
}

/** The tab `step` tabs on from `activeId`, going round: Next tab is 1, Previous tab is -1. */
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
