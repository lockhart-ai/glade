/**
 * The global terminal's tabs, in main: main owns every shell, each in its own pseudo-terminal, and the renderer only
 * shows them. It types into a tab's shell and resizes it through bridge commands, and gets its output as events.
 *
 * What survives a restart is in SQLite (`terminal_tabs`): the tabs, in order, with their names and folders, and each
 * one's recent output. Processes don't survive: on relaunch each tab shows its old output, a dim divider saying so, and
 * a new shell under it. A tab's shell starts when the window first shows it (`attach`), at the terminal's size.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import type { TerminalTab } from '../../shared/terminal'
import { CommandFailure } from '../bridge/errors'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { Emit } from '../bridge/events'
import {
  addTerminalTab,
  listTerminalTabs,
  removeTerminalTab,
  renameTerminalTab,
  saveTerminalScrollback,
} from '../db/repositories/terminal-tabs'
import { isRunningProgram, processName } from './foreground'
import type { Pty, PtyExit, SpawnPty, TerminalSize } from './pty'
import { shellName, type TerminalShell } from './shell'

/** How much of a tab's recent output is kept, and restored on relaunch, in characters. */
export const SCROLLBACK_LIMIT = 100_000

/** How often the tabs' foreground processes are checked, for the running dot and the tab's default name. */
export const PROCESS_POLL_MS = 500

/** How soon new output is saved, at most: output that arrives meanwhile is saved with it. */
export const SAVE_DELAY_MS = 1_000

/**
 * What a restored tab shows between its old output and its new shell: dim, on a line of its own, saying the processes
 * didn't survive the restart.
 */
export const RESTORED_DIVIDER =
  "\r\n\x1b[0m\x1b[2m──── Restored from the last session. Processes don't survive a restart: this is a new shell. ────\x1b[0m\r\n"

/**
 * The last `limit` characters of a tab's output, from the start of a line, so the kept output doesn't begin partway
 * through a line or an escape sequence (unless a single line is longer than the limit).
 */
export function trimScrollback(output: string, limit: number = SCROLLBACK_LIMIT): string {
  if (output.length <= limit) return output
  const kept = output.slice(-limit)
  const lineStart = kept.indexOf('\n')
  return lineStart === -1 ? kept : kept.slice(lineStart + 1)
}

/** A tab's output so far, for a window to show when it first shows the tab. */
export interface TerminalSnapshot {
  /** The tab's recent output: the last of it, up to `SCROLLBACK_LIMIT`. */
  readonly output: string
  /**
   * Where the output ends, counted in characters of everything the tab has output since the app started: the
   * `offset` of the next `terminal.output` event, so a window can drop the events it already has in the snapshot.
   */
  readonly end: number
}

/** What the terminal tabs need from the app. */
export interface TerminalsContext {
  readonly db: Database
  readonly emit: Emit
  /** Starts a shell in a pseudo-terminal: node-pty in the app, a fake in unit tests. */
  readonly spawn: SpawnPty
  readonly shell: TerminalShell
  /** Where a shell starts when its folder is gone, or when there's no workspace: the home folder. */
  readonly fallbackCwd: string
  /** Where tabs opening and closing, and shells starting and exiting, are logged. Nothing by default. */
  readonly log?: Logger
}

/** The terminal tabs. Every method that names a tab throws a `not_found` `CommandFailure` when there's no such tab. */
export interface Terminals {
  /** Every tab, in the tab row's order. */
  list(): TerminalTab[]
  /** Adds a tab at the end whose shell will start in `cwd`, or in the fallback folder when it's null. */
  create(cwd: string | null): TerminalTab
  /** Adds a tab after `id`, with its name and folder. */
  duplicate(id: string): TerminalTab
  /** Starts the tab's shell at `size`, if it hasn't started, and answers with its output so far. */
  attach(id: string, size: TerminalSize): TerminalSnapshot
  /**
   * Types into the tab's shell. What's typed before the shell has shown its prompt (its first output) waits until it
   * has, so a command put in a new tab lands at the prompt.
   */
  write(id: string, data: string): void
  resize(id: string, size: TerminalSize): void
  /** Names a tab. */
  rename(id: string, name: string): void
  /** Forgets the tab's output (⌘K): the windows clear it, and a relaunch won't bring it back. */
  clear(id: string): void
  /** Sends SIGINT to what's running in the tab's foreground (Kill process, ⌃C). */
  interrupt(id: string): void
  /** Ends the tab's shell and removes the tab. */
  close(id: string): void
  /** Saves every tab's output now, and ends every shell, keeping the tabs: for the app quitting. */
  shutdown(): void
}

/** A tab, and its shell once it has started. */
interface LiveTab {
  readonly id: string
  name: string | null
  readonly cwd: string
  pty: Pty | null
  /** The foreground process's name, as last checked. */
  process: string
  running: boolean
  /** The recent output, trimmed to `SCROLLBACK_LIMIT`. */
  output: string
  /** How much the tab has output since the app started, restored output included. */
  total: number
  /** Whether the shell has output anything yet: typing waits until it has. */
  ready: boolean
  /** What was typed before the shell was ready, in order. */
  typedAhead: string[]
  /** Whether its output has changed since it was last saved. */
  unsaved: boolean
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

/** Loads the terminal tabs from the database, each with its old output and, when it had some, the restored divider. */
export function createTerminals({
  db,
  emit,
  spawn,
  shell,
  fallbackCwd,
  log = SILENT_LOGGER,
}: TerminalsContext): Terminals {
  const idleName = shellName(shell)
  let shuttingDown = false
  let poll: NodeJS.Timeout | null = null
  let save: NodeJS.Timeout | null = null

  const restored = (scrollback: string): string => (scrollback === '' ? '' : `${scrollback}${RESTORED_DIVIDER}`)
  const tabs: LiveTab[] = listTerminalTabs(db).map(({ id, name, cwd, scrollback }) => {
    const output = trimScrollback(restored(scrollback))
    return {
      id,
      name,
      cwd,
      pty: null,
      process: idleName,
      running: false,
      output,
      total: output.length,
      ready: false,
      typedAhead: [],
      unsaved: output !== scrollback,
    }
  })

  const view = ({ id, name, cwd, process, running }: LiveTab): TerminalTab => ({ id, name, process, running, cwd })

  const tabsChanged = (): void => {
    emit({ type: EventType.TerminalTabsChanged, tabs: tabs.map(view) })
  }

  const find = (id: string): LiveTab => {
    const tab = tabs.find((candidate) => candidate.id === id)
    if (tab === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No terminal tab ${id}`)
    return tab
  }

  const saveNow = (): void => {
    if (save !== null) clearTimeout(save)
    save = null
    for (const tab of tabs) {
      if (!tab.unsaved) continue
      saveTerminalScrollback(db, tab.id, tab.output)
      tab.unsaved = false
    }
  }

  const saveSoon = (): void => {
    save ??= setTimeout(saveNow, SAVE_DELAY_MS)
  }

  // The running dot and a tab's default name follow its foreground process, which the terminal doesn't announce.
  const checkProcesses = (): void => {
    let changed = false
    for (const tab of tabs) {
      if (tab.pty === null) continue
      const foreground = tab.pty.process
      const running = isRunningProgram(foreground, idleName)
      const process = running ? processName(foreground) : idleName
      if (process === tab.process && running === tab.running) continue
      tab.process = process
      tab.running = running
      changed = true
    }
    if (changed) tabsChanged()
  }

  const stopPolling = (): void => {
    if (poll === null || tabs.some((tab) => tab.pty !== null)) return
    clearInterval(poll)
    poll = null
  }

  const append = (tab: LiveTab, data: string): void => {
    const offset = tab.total
    tab.output = trimScrollback(tab.output + data)
    tab.total += data.length
    tab.unsaved = true
    saveSoon()
    emit({ type: EventType.TerminalOutput, tabId: tab.id, offset, data })
    if (tab.ready || tab.pty === null) return
    tab.ready = true
    for (const typed of tab.typedAhead.splice(0)) tab.pty.write(typed)
  }

  // The shell exited on its own (`exit`, or it couldn't start): its tab goes, as a Terminal.app window would.
  const exited = (tab: LiveTab, { exitCode, signal }: PtyExit): void => {
    log.info('shell exited', { tabId: tab.id, exitCode, signal, closing: shuttingDown || !tabs.includes(tab) })
    if (shuttingDown || !tabs.includes(tab)) return
    tab.pty = null
    remove(tab)
  }

  const start = (tab: LiveTab, size: TerminalSize): Pty => {
    const cwd = isDirectory(tab.cwd) ? tab.cwd : fallbackCwd
    log.info('shell starting', { tabId: tab.id, shell: shell.file, args: shell.args, cwd, size })
    const pty = spawn({ file: shell.file, args: shell.args, cwd, size, env: shell.env })
    tab.pty = pty
    pty.onData((data) => {
      if (tab.pty === pty) append(tab, data)
    })
    pty.onExit((exit) => {
      if (tab.pty === pty) exited(tab, exit)
      else log.info('shell exited', { tabId: tab.id, ...exit, closing: true })
    })
    poll ??= setInterval(checkProcesses, PROCESS_POLL_MS)
    return pty
  }

  const remove = (tab: LiveTab): void => {
    log.info('terminal tab closed', { tabId: tab.id })
    tabs.splice(tabs.indexOf(tab), 1)
    removeTerminalTab(db, tab.id)
    stopPolling()
    tabsChanged()
  }

  const add = (name: string | null, cwd: string, after: string | null): TerminalTab => {
    const id = randomUUID()
    addTerminalTab(db, { id, name, cwd, after })
    const tab: LiveTab = {
      id,
      name,
      cwd,
      pty: null,
      process: idleName,
      running: false,
      output: '',
      total: 0,
      ready: false,
      typedAhead: [],
      unsaved: false,
    }
    const index = after === null ? -1 : tabs.findIndex((candidate) => candidate.id === after)
    tabs.splice(index === -1 ? tabs.length : index + 1, 0, tab)
    log.info('terminal tab opened', { tabId: id, cwd, after })
    tabsChanged()
    return view(tab)
  }

  return {
    list: () => tabs.map(view),

    create: (cwd) => add(null, cwd ?? fallbackCwd, null),

    duplicate: (id) => {
      const { name, cwd } = find(id)
      return add(name, cwd, id)
    },

    attach: (id, size) => {
      const tab = find(id)
      if (tab.pty === null) start(tab, size)
      return { output: tab.output, end: tab.total }
    },

    write: (id, data) => {
      const tab = find(id)
      if (tab.pty === null || !tab.ready) tab.typedAhead.push(data)
      else tab.pty.write(data)
    },

    resize: (id, size) => {
      find(id).pty?.resize(size)
    },

    rename: (id, name) => {
      const tab = find(id)
      tab.name = name
      renameTerminalTab(db, id, name)
      tabsChanged()
    },

    clear: (id) => {
      const tab = find(id)
      tab.output = ''
      tab.unsaved = true
      saveSoon()
      emit({ type: EventType.TerminalCleared, tabId: id })
    },

    interrupt: (id) => {
      find(id).pty?.interrupt()
    },

    close: (id) => {
      const tab = find(id)
      const { pty } = tab
      tab.pty = null
      pty?.kill()
      remove(tab)
    },

    shutdown: () => {
      log.info('terminals shutting down', { tabs: tabs.length, running: tabs.filter((tab) => tab.pty !== null).length })
      shuttingDown = true
      saveNow()
      if (poll !== null) clearInterval(poll)
      poll = null
      for (const tab of tabs) {
        tab.pty?.kill()
        tab.pty = null
      }
    },
  }
}
