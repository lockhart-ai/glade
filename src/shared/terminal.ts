/**
 * The terminal in the bottom bar: its tabs, each a shell main runs in a pseudo-terminal (node-pty). Each workspace has
 * its own tabs, not each task (`docs/decisions.md`): the bottom bar shows the tabs of the workspace you're looking at,
 * and a new tab's shell starts in its root. The other workspaces' shells keep running meanwhile.
 */

/** One terminal tab, as the tab row shows it. */
export interface TerminalTab {
  readonly id: string
  /**
   * The workspace it belongs to, whose bottom bar shows it; null for a tab opened while no workspace was open, which
   * the window shows while none is.
   */
  readonly workspaceId: string | null
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

/**
 * The tab each workspace's bottom bar shows, as the `terminal_selection` UI state keeps it: from a workspace's key
 * (`terminalWorkspaceKey`) to a tab's id.
 */
export type TerminalSelection = Readonly<Record<string, string>>

/** A workspace's key in a `TerminalSelection`: its id, or `''` for no workspace. */
export function terminalWorkspaceKey(workspaceId: string | null): string {
  return workspaceId ?? ''
}

/** A selection as its UI state value. */
export function serializeTerminalSelection(selection: TerminalSelection): string {
  return JSON.stringify(selection)
}

/**
 * The selection a UI state value holds: empty when it's unset or isn't one, and without any entry that doesn't name a
 * tab by a string.
 */
export function parseTerminalSelection(value: string | undefined): TerminalSelection {
  if (value === undefined) return {}
  let json: unknown
  try {
    json = JSON.parse(value)
  } catch {
    return {}
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {}
  return Object.fromEntries(
    Object.entries(json).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}
