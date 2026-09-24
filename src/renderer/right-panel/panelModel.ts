// The right panel's state, as it's stored in UI state: its selected tab and its width. (Whether it's collapsed is
// `../panels`, with the other panels'.)

/** The right panel's tabs, in the order the tab bar shows them (and ⌘⌥1–5 picks them). */
export enum PanelTab {
  ToolCalls = 'tool-calls',
  Files = 'files',
  Todos = 'todos',
  Artifacts = 'artifacts',
  Subagents = 'subagents',
}

/** Every tab, in tab bar order. */
export const PANEL_TABS: readonly PanelTab[] = Object.values(PanelTab)

function isPanelTab(value: string): value is PanelTab {
  return (PANEL_TABS as readonly string[]).includes(value)
}

/** The stored tab, or Tool calls when none is stored (or a newer version stored one this version doesn't know). */
export function parsePanelTab(value: string | undefined): PanelTab {
  return value !== undefined && isPanelTab(value) ? value : PanelTab.ToolCalls
}

/** The tab ⌘⌥ and a digit picks: 1 is Tool calls, 5 is Subagents. Undefined for any other digit. */
export function tabForDigit(digit: number): PanelTab | undefined {
  return PANEL_TABS[digit - 1]
}

/** The panel's width until you drag it, from docs/design/html/task-workspace.html. */
export const DEFAULT_PANEL_WIDTH = 440

/** The narrowest the panel gets. */
export const MIN_PANEL_WIDTH = 320

/**
 * The narrowest the chat column beside the panel gets while the panel is wider than its minimum. At the 1100px window
 * minimum this leaves the panel about its minimum width, and in a 1920px window the panel can reach 08-open-file's 780px
 * and more.
 */
export const MIN_CHAT_WIDTH = 380

/** How far one press of ← or → on the resize handle moves it. */
export const PANEL_WIDTH_STEP = 16

/** How narrow and how wide the panel can be. */
export interface WidthBounds {
  readonly min: number
  readonly max: number
}

/**
 * The panel's bounds when it and the chat share `available` pixels (the task card's content width, less the gap
 * between them): the chat keeps `MIN_CHAT_WIDTH`, unless that would squeeze the panel below its own minimum.
 */
export function widthBounds(available: number): WidthBounds {
  return { min: MIN_PANEL_WIDTH, max: Math.max(MIN_PANEL_WIDTH, Math.round(available - MIN_CHAT_WIDTH)) }
}

/** `width` held within `bounds`, in whole pixels. */
export function clampWidth(width: number, { min, max }: WidthBounds): number {
  return Math.round(Math.min(Math.max(width, min), max))
}

/**
 * The stored width, or the default when none is stored or it isn't a number. A stored width is never below the
 * minimum; how wide the panel can be depends on the window, so the layout caps it as it renders.
 */
export function parsePanelWidth(value: string | undefined): number {
  const width = value === undefined || value === '' ? NaN : Number(value)
  return Number.isFinite(width) ? Math.max(Math.round(width), MIN_PANEL_WIDTH) : DEFAULT_PANEL_WIDTH
}

/** A tab's count: a plain number (`7` tool calls) or progress (`3/4` todos). */
export type PanelCount = number | { readonly done: number; readonly total: number }

/** How a count reads beside its tab's label, or undefined to show none: a count of zero, or progress out of zero. */
export function formatCount(count: PanelCount): string | undefined {
  if (typeof count === 'number') return count === 0 ? undefined : String(count)
  return count.total === 0 ? undefined : `${String(count.done)}/${String(count.total)}`
}
