// How big the resizable panels are (the sidebar's width, the right panel's width, the bottom bar's height and the
// plugin card's width beside the terminal), as it's stored in UI state, and the limits each one keeps to. Each panel
// resizes with the same handle (`../layout/ResizeHandle`); only its edge and its limits differ.
import { UiStateKey } from '../../shared/domain'
import { Panel } from './panels'

/** The panes that resize but don't collapse on their own, so have no toggle (`Panel` has those that do). */
export enum Pane {
  /** The shown plugin's card, beside the terminal in the bottom bar: it collapses with the bar. */
  Plugin = 'plugin',
}

/** Anything a resize handle sizes: a collapsible panel, or a pane. */
export type SizedPanel = Panel | Pane

/** How small and how big a panel can be, in CSS pixels. */
export interface SizeBounds {
  readonly min: number
  readonly max: number
}

/** A panel's size, as its handle and UI state know it. */
export interface PanelSizeDefinition {
  /** Where the size you last chose is stored. */
  readonly key: UiStateKey
  /** Its size until you resize it. */
  readonly initial: number
  /** The smallest it gets. */
  readonly min: number
  /** The biggest it gets however much room there is, or undefined for no such limit (the room there is limits it). */
  readonly max: number | undefined
}

/** The sidebar's width until you drag it, from docs/design/html/task-workspace.html. */
export const DEFAULT_SIDEBAR_WIDTH = 300

/** The narrowest the sidebar gets: the task list's toolbar and a task's title still fit. */
export const MIN_SIDEBAR_WIDTH = 240

/** The widest the sidebar gets, however wide the window: past this the task list is mostly empty space. */
export const MAX_SIDEBAR_WIDTH = 520

/** The right panel's width until you drag it, from docs/design/html/task-workspace.html. */
export const DEFAULT_PANEL_WIDTH = 440

/** The narrowest the right panel gets. */
export const MIN_PANEL_WIDTH = 320

/** The bottom bar's height until you drag it, from docs/design/html/task-workspace.html. */
export const DEFAULT_BOTTOM_BAR_HEIGHT = 300

/** The shortest the bottom bar gets while it's open: its tab row and a few lines of the terminal. */
export const MIN_BOTTOM_BAR_HEIGHT = 120

/**
 * The narrowest the chat column gets while the right panel is wider than its minimum, or the sidebar wider than its
 * own. At the 1100px window minimum this leaves the right panel about its minimum width, and in a 1920px window the
 * panel can reach 08-open-file's 780px and more. It's the column's width, the header card's and input bar's: the chat
 * runs `--space-inset` (8px) inside them on each side (#268), so the chat itself keeps 380px, enough for a question's
 * two option cards to share a row beside its scroll bar (QuestionCard.module.css).
 */
export const MIN_CHAT_WIDTH = 396

/**
 * The shortest the task card gets, which the bottom bar gives way to: room for the compact header, the input bar and
 * the chat's minimum height between them. In the 700px window minimum it leaves the bottom bar about 200px.
 */
export const MIN_TASK_HEIGHT = 460

/** The plugin card's width until you drag it, from docs/design/html/task-workspace.html. */
export const DEFAULT_PLUGIN_WIDTH = 680

/** The narrowest the plugin card gets: its header's icon, name, badge and a short status still fit. */
export const MIN_PLUGIN_WIDTH = 280

/**
 * The narrowest the terminal gets beside the plugin card, which the card gives way to: its tab row's first tabs and
 * about 45 columns. At the 1100px window minimum it leaves the plugin card room for the design's 680px.
 */
export const MIN_TERMINAL_WIDTH = 360

/** How far one press of an arrow key on a resize handle moves it. */
export const RESIZE_STEP = 16

/** Each panel's size. */
export function panelSize(panel: SizedPanel): PanelSizeDefinition {
  switch (panel) {
    case Panel.Sidebar:
      return {
        key: UiStateKey.SidebarWidth,
        initial: DEFAULT_SIDEBAR_WIDTH,
        min: MIN_SIDEBAR_WIDTH,
        max: MAX_SIDEBAR_WIDTH,
      }
    case Panel.RightPanel:
      return { key: UiStateKey.RightPanelWidth, initial: DEFAULT_PANEL_WIDTH, min: MIN_PANEL_WIDTH, max: undefined }
    case Panel.BottomBar:
      return {
        key: UiStateKey.BottomBarHeight,
        initial: DEFAULT_BOTTOM_BAR_HEIGHT,
        min: MIN_BOTTOM_BAR_HEIGHT,
        max: undefined,
      }
    case Pane.Plugin:
      return { key: UiStateKey.PluginWidth, initial: DEFAULT_PLUGIN_WIDTH, min: MIN_PLUGIN_WIDTH, max: undefined }
  }
}

/**
 * A panel's bounds when `room` pixels could go to it: all of it, up to the panel's own maximum, but never below its
 * minimum (the window's minimum size leaves room for every panel's minimum).
 */
export function sizeBounds(panel: SizedPanel, room: number): SizeBounds {
  const { min, max } = panelSize(panel)
  const fits = Math.max(min, Math.round(room))
  return { min, max: max === undefined ? fits : Math.min(fits, max) }
}

/** `size` held within `bounds`, in whole pixels. */
export function clampSize(size: number, { min, max }: SizeBounds): number {
  return Math.round(Math.min(Math.max(size, min), max))
}

/**
 * A panel's stored size, or its default when none is stored or it isn't a number. A stored size is never below the
 * minimum nor above the maximum; how big the panel can be also depends on the window, so the layout caps it as it
 * renders.
 */
export function parsePanelSize(panel: SizedPanel, value: string | undefined): number {
  const { initial, min, max } = panelSize(panel)
  const size = value === undefined || value === '' ? NaN : Number(value)
  if (!Number.isFinite(size)) return initial
  return clampSize(size, { min, max: max ?? Infinity })
}
