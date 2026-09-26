/**
 * Glade in the macOS menu bar (`docs/design/html/29-menu-bar.html`, #271): an icon showing what's in flight, and a
 * popover under it listing it.
 *
 * - The icon is a monochrome template glyph (so it follows light and dark menu bars) with, while tasks need you, their
 *   count beside it. While any agent works it pulses (`./pulse`), unless Reduce motion is on.
 * - Clicking it shows the popover: a small window of Glade's own page (`#menu-bar`), anchored under the icon. It hides
 *   when it loses focus, on Esc, or on a second click of the icon, and its page is kept up to date while it's open.
 * - Settings › General › Show Glade in the menu bar (`showInMenuBar`, on by default) adds and removes it as it changes.
 *
 * This module decides all of that. What draws it is behind `MenuBarTray` and `MenuBarPopover`: Electron's `Tray` and a
 * `BrowserWindow` in the app (`./electron`), and a recording in e2e mode (`./recording`), which never shows anything.
 */
import type { Database } from 'better-sqlite3'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { menuBarIcon, type MenuBarSnapshot } from '../../shared/menuBar'
import { getSettings } from '../db/repositories/settings'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { Bounds } from './position'
import { createPulse } from './pulse'
import { readMenuBarSnapshot } from './snapshot'

/** How long after a change the icon and popover catch up: a burst of changes (a turn streaming in) makes one refresh. */
export const REFRESH_DELAY_MS = 100

/**
 * How soon after the popover hides a click on the icon counts as the one that hid it: clicking the icon takes the focus
 * from the popover, which hides it, before the click arrives. That click closes it, rather than showing it again.
 */
export const REOPEN_GRACE_MS = 300

/** The icon in the menu bar. */
export interface MenuBarTray {
  /** Draws the glyph at one of its strengths (`GLYPH_STRENGTHS`): 0 is full strength. */
  setFrame(frame: number): void
  /** Sets the text beside the glyph: the Needs you count, or nothing. */
  setTitle(title: string): void
  /** Where the icon is on the screen, for the popover to drop under it. */
  bounds(): Bounds
  /** Takes it out of the menu bar. */
  destroy(): void
}

/** What the icon does when you act on it. */
export interface TrayHandlers {
  readonly onClick: () => void
}

/** Puts the icon in the menu bar, showing the glyph at full strength. */
export type CreateTray = (handlers: TrayHandlers) => MenuBarTray

/** The popover: a window of Glade's own page, under the icon. */
export interface MenuBarPopover {
  /** Shows it under `anchor`, the icon's bounds, and gives it the focus. */
  show(anchor: Bounds): void
  hide(): void
  /** Sends its page an event. */
  send(event: GladeEvent): void
  /** Sizes it to the height its page lays out at, within the screen. */
  fit(height: number): void
  /** Closes its window for good. */
  destroy(): void
}

/** What the popover does when it hides itself: it lost the focus, or you pressed Esc. */
export interface PopoverHandlers {
  readonly onHidden: () => void
}

/** Makes the popover, hidden, the first time the icon is clicked. */
export type CreatePopover = (handlers: PopoverHandlers) => MenuBarPopover

/** What the popover's page asks of main (the bridge's `menuBar.*` commands). */
export interface MenuBarCommands {
  /** Hides the popover and opens Glade on a task, in its workspace. */
  openTask(taskId: string): void
  /** Hides the popover and brings Glade's window up. */
  openGlade(): void
  /** Hides the popover (Esc). */
  hide(): void
  /** Quits Glade. */
  quit(): void
  /** Sizes the popover to its page's height. */
  fit(height: number): void
}

export interface MenuBarOptions {
  readonly db: Database
  readonly createTray: CreateTray
  readonly createPopover: CreatePopover
  /** Whether macOS has Reduce motion on: read each time the icon is drawn, and again when `motionChanged` is called. */
  readonly reduceMotion: () => boolean
  /** Opens Glade on a task, switching workspace if it has to, as clicking its notification does. */
  readonly openTask: (taskId: string) => void
  /** Brings Glade's window up, opening one when there's none. */
  readonly openGlade: () => void
  readonly quit: () => void
  /** The clock, for telling a click that hid the popover from one that should show it. `Date.now` by default. */
  readonly now?: () => number
  readonly log?: Logger
}

/** Glade's icon in the menu bar, and its popover. */
export interface MenuBar extends MenuBarCommands {
  /** Adds the icon or takes it away, as Settings › General › Show Glade in the menu bar has it. */
  sync(): void
  /** Hears every event main sends the windows, and catches up with those that change what's in flight. */
  observe(event: GladeEvent): void
  /** Catches up with a change now: redraws the icon, and sends the popover's page what's in flight. */
  refresh(): void
  /** Catches up soon (`REFRESH_DELAY_MS`), once for a burst of changes, such as a notification being sent. */
  changed(): void
  /** Reduce motion was turned on or off: the pulse stops or starts. */
  motionChanged(): void
  /** Clicking the icon: shows the popover, or hides it if it's showing. */
  toggle(): void
  /** Takes the icon away and closes the popover, when the app quits. */
  close(): void
  /** Whether the icon is in the menu bar. */
  readonly shown: boolean
  /** Whether the popover is showing. */
  readonly open: boolean
  /** Whether the icon is pulsing. */
  readonly pulsing: boolean
}

/**
 * Whether an event changes what's in flight: a task's state, activity, status, title or todos, a question or
 * permission card opening or closing (which set whether it needs you), or a workspace's name.
 */
function changesWhatsInFlight(event: GladeEvent): boolean {
  switch (event.type) {
    case EventType.TaskUpdated:
    case EventType.TaskDeleted:
    case EventType.QuestionOpened:
    case EventType.QuestionAnswered:
    case EventType.QuestionWithdrawn:
    case EventType.PermissionOpened:
    case EventType.PermissionAnswered:
    case EventType.PermissionWithdrawn:
    case EventType.TodosChanged:
    case EventType.WorkspaceUpdated:
    case EventType.WorkspaceRemoved:
      return true
    case EventType.UiStateChanged:
    case EventType.MessageAppended:
    case EventType.ToolEventAppended:
    case EventType.ToolEventUpdated:
    case EventType.TaskOpenRequested:
    case EventType.QueueChanged:
    case EventType.OpenFilesChanged:
    case EventType.FileShown:
    case EventType.ArtifactsChanged:
    case EventType.HandoffChanged:
    case EventType.WatchersChanged:
    case EventType.CommitsChanged:
    case EventType.TerminalTabsChanged:
    case EventType.TerminalOutput:
    case EventType.TerminalCleared:
    case EventType.MenuCommand:
    case EventType.SettingsChanged:
    case EventType.PluginsChanged:
    case EventType.PluginStatusChanged:
    case EventType.ControlChanged:
    case EventType.MenuBarChanged:
      return false
  }
}

export function createMenuBar({
  db,
  createTray,
  createPopover,
  reduceMotion,
  openTask,
  openGlade,
  quit,
  now = Date.now,
  log = SILENT_LOGGER,
}: MenuBarOptions): MenuBar {
  let tray: MenuBarTray | null = null
  let popover: MenuBarPopover | null = null
  let open = false
  let hiddenAt = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  const pulse = createPulse((frame) => {
    tray?.setFrame(frame)
  })

  const cancelRefresh = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  /** Draws the icon for `snapshot`, pulsing it while anything works and motion's allowed. */
  const draw = (snapshot: MenuBarSnapshot): void => {
    if (tray === null) return
    const icon = menuBarIcon(snapshot, reduceMotion())
    tray.setTitle(icon.title)
    pulse.set(icon.pulse)
  }

  const refresh = (): void => {
    cancelRefresh()
    if (tray === null) return
    const snapshot = readMenuBarSnapshot(db)
    draw(snapshot)
    popover?.send({ type: EventType.MenuBarChanged, snapshot })
  }

  const changed = (): void => {
    if (tray === null || timer !== null) return
    timer = setTimeout(refresh, REFRESH_DELAY_MS)
  }

  const hide = (): void => {
    if (!open) return
    open = false
    hiddenAt = now()
    popover?.hide()
  }

  const show = (): void => {
    if (tray === null) return
    popover ??= createPopover({
      onHidden: () => {
        if (!open) return
        open = false
        hiddenAt = now()
      },
    })
    open = true
    // Its page may have missed changes while it was hidden: it gets what's in flight now, as it shows.
    refresh()
    popover.show(tray.bounds())
  }

  const add = (): void => {
    log.info('menu bar icon added')
    tray = createTray({ onClick: toggle })
    refresh()
  }

  const remove = (): void => {
    log.info('menu bar icon removed')
    cancelRefresh()
    pulse.set(false)
    open = false
    popover?.destroy()
    popover = null
    tray?.destroy()
    tray = null
  }

  const sync = (): void => {
    const wanted = getSettings(db).showInMenuBar
    if (wanted && tray === null) add()
    else if (!wanted && tray !== null) remove()
  }

  function toggle(): void {
    if (open) {
      hide()
      return
    }
    // The click that took the focus from the popover, and so hid it, closes it rather than showing it again.
    if (now() - hiddenAt < REOPEN_GRACE_MS) return
    show()
  }

  return {
    get shown() {
      return tray !== null
    },
    get open() {
      return open
    },
    get pulsing() {
      return pulse.on
    },
    sync,
    observe(event) {
      if (event.type === EventType.SettingsChanged) {
        sync()
        return
      }
      if (changesWhatsInFlight(event)) changed()
    },
    refresh,
    changed,
    motionChanged() {
      if (tray === null) return
      draw(readMenuBarSnapshot(db))
    },
    toggle,
    hide,
    openTask(taskId) {
      hide()
      openTask(taskId)
    },
    openGlade() {
      hide()
      openGlade()
    },
    quit() {
      hide()
      quit()
    },
    fit(height) {
      popover?.fit(height)
    },
    close() {
      if (tray !== null) remove()
    },
  }
}
