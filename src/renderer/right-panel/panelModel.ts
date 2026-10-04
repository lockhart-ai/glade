// The right panel's state, as it's stored in UI state: its selected tab, per workspace (#432). (Whether it's
// collapsed, and its width, are `../panels`, with the other panels'.)
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import type { UiStateValues } from '../store/state'

/**
 * The right panel's tabs: today's seven, in the order the tab bar shows them (and ⌘⌥1–7 picks them), and Agents, which
 * takes the place of Tool calls, Subagents and Watchers while the todo hub is on (P16, #491; see `panelTabs`).
 */
export enum PanelTab {
  ToolCalls = 'tool-calls',
  Files = 'files',
  Todos = 'todos',
  Artifacts = 'artifacts',
  Subagents = 'subagents',
  Watchers = 'watchers',
  Changes = 'changes',
  Agents = 'agents',
}

/** Every tab the panel shows with the todo hub off, in tab bar order. */
export const PANEL_TABS: readonly PanelTab[] = [
  PanelTab.ToolCalls,
  PanelTab.Files,
  PanelTab.Todos,
  PanelTab.Artifacts,
  PanelTab.Subagents,
  PanelTab.Watchers,
  PanelTab.Changes,
]

/**
 * Every tab the panel shows with the todo hub on (the hidden `todoHubEnabled` setting, until #501 makes them the only
 * ones), in tab bar order: Agents · Files · Todos (⌘⌥1–3).
 */
export const HUB_PANEL_TABS: readonly PanelTab[] = [PanelTab.Agents, PanelTab.Files, PanelTab.Todos]

/** The tabs the panel shows, in tab bar order: three with the todo hub on, today's seven with it off. */
export function panelTabs(hub: boolean): readonly PanelTab[] {
  return hub ? HUB_PANEL_TABS : PANEL_TABS
}

function isPanelTab(value: string): value is PanelTab {
  return (Object.values(PanelTab) as readonly string[]).includes(value)
}

/** The stored tab, or Tool calls when none is stored (or a newer version stored one this version doesn't know). */
export function parsePanelTab(value: string | undefined): PanelTab {
  return value !== undefined && isPanelTab(value) ? value : PanelTab.ToolCalls
}

/**
 * The tab each workspace's right panel shows, as the `right_panel_tabs` UI state keeps it: from a workspace's id to
 * its tab.
 */
export type PanelTabSelection = Readonly<Record<string, PanelTab>>

/** A selection as its UI state value. */
export function serializePanelTabSelection(selection: PanelTabSelection): string {
  return JSON.stringify(selection)
}

/**
 * The selection a UI state value holds: empty when it's unset or isn't one, and without any entry that isn't a known
 * tab.
 */
export function parsePanelTabSelection(value: string | undefined): PanelTabSelection {
  if (value === undefined) return {}
  let json: unknown
  try {
    json = JSON.parse(value)
  } catch {
    return {}
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {}
  return Object.fromEntries(
    Object.entries(json).filter(
      (entry): entry is [string, PanelTab] => typeof entry[1] === 'string' && isPanelTab(entry[1]),
    ),
  )
}

/**
 * The tab a workspace's right panel shows: the one last picked there, or else the tab stored before each workspace
 * had its own (`UiStateKey.RightPanelTab`, every workspace's starting value), or else the first tab. A tab the panel
 * doesn't show (one the todo hub replaced while it's on, or Agents while it's off) is the first tab too: Agents with
 * the hub on, Tool calls with it off. What's stored is left as it is, so turning the hub off again shows the tab it
 * was on.
 */
export function activePanelTab(uiState: UiStateValues, workspaceId: string, hub = false): PanelTab {
  const picked = parsePanelTabSelection(uiState[UiStateKey.RightPanelTabs])[workspaceId]
  const stored = picked ?? parsePanelTab(uiState[UiStateKey.RightPanelTab])
  return panelTabs(hub).includes(stored) ? stored : firstPanelTab(hub)
}

/** The tab a panel with nothing stored starts on: Agents with the todo hub on, Tool calls with it off. */
export function firstPanelTab(hub: boolean): PanelTab {
  return hub ? PanelTab.Agents : PanelTab.ToolCalls
}

/** The UI state that makes `tab` the one `workspaceId`'s right panel shows, keeping every other workspace's. */
export function panelTabEntry(uiState: UiStateValues, workspaceId: string, tab: PanelTab): UiStateEntry {
  const kept = Object.entries(parsePanelTabSelection(uiState[UiStateKey.RightPanelTabs])).filter(
    ([id]) => id !== workspaceId,
  )
  const selection: PanelTabSelection = Object.fromEntries([...kept, [workspaceId, tab]])
  return { key: UiStateKey.RightPanelTabs, value: serializePanelTabSelection(selection) }
}

/**
 * The tab ⌘⌥ and a digit picks: 1 is Tool calls and 7 is Changes, or with the todo hub on, 1 is Agents and 3 is Todos.
 * Undefined for any other digit.
 */
export function tabForDigit(digit: number, hub = false): PanelTab | undefined {
  return panelTabs(hub)[digit - 1]
}

/** A tab's count: a plain number (`7` tool calls) or progress (`3/4` todos). */
export type PanelCount = number | { readonly done: number; readonly total: number }

/** How a count reads beside its tab's label, or undefined to show none: a count of zero, or progress out of zero. */
export function formatCount(count: PanelCount): string | undefined {
  if (typeof count === 'number') return count === 0 ? undefined : String(count)
  return count.total === 0 ? undefined : `${String(count.done)}/${String(count.total)}`
}
