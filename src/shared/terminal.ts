/**
 * The global terminal in the bottom bar: its tabs, each a shell main runs in a pseudo-terminal (node-pty). The terminal
 * is global, not per task (`docs/decisions.md`): a new tab's shell starts in the root of the workspace you're looking at.
 */

/** One terminal tab, as the tab row shows it. */
export interface TerminalTab {
  readonly id: string
  /** The name you gave it (Rename…), or null for the default: what's running in it (see `terminalTitle`). */
  readonly name: string | null
  /**
   * The name of the process in the foreground of its terminal: the shell's (`zsh`) while it waits on you, or the
   * program's it's running (`python`).
   */
  readonly process: string
  /** Whether a program other than the shell is running in the foreground: the tab shows a dot. */
  readonly running: boolean
  /** The folder its shell started in, absolute. */
  readonly cwd: string
}

/** What a tab is called in the tab row: the name you gave it, or else what's running in it. */
export function terminalTitle(tab: Pick<TerminalTab, 'name' | 'process'>): string {
  return tab.name ?? tab.process
}

/** The most a terminal tab's name can be, in characters. */
export const MAX_TERMINAL_NAME = 100

/** The most one `terminal.write` can send, in characters: a large paste, well beyond anything typed. */
export const MAX_TERMINAL_WRITE = 1_000_000

/** The largest a terminal can be, in columns or rows. */
export const MAX_TERMINAL_SIZE = 2_000
