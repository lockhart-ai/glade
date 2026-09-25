// The right panel's state, as it's stored in UI state: its selected tab. (Whether it's collapsed, and its width, are
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

/** A tab's count: a plain number (`7` tool calls) or progress (`3/4` todos). */
export type PanelCount = number | { readonly done: number; readonly total: number }

/** How a count reads beside its tab's label, or undefined to show none: a count of zero, or progress out of zero. */
export function formatCount(count: PanelCount): string | undefined {
  if (typeof count === 'number') return count === 0 ? undefined : String(count)
  return count.total === 0 ? undefined : `${String(count.done)}/${String(count.total)}`
}
