// The right panel's state, as it's stored in UI state: its selected tab, per workspace (#432). (Whether it's
// collapsed, and its width, are `../panels`, with the other panels'.)
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import type { UiStateValues } from '../store/state'

/**
 * The right panel's tabs (P16, #491), in the order the tab bar shows them (and ⌘⌥1–3 picks them): Agents is what's
 * happening (every agent's tool calls and watchers), Files is the workspace's files, and Todos is what the work
 * produced (each todo with its files, links and changes).
 */
export enum PanelTab {
  Agents = 'agents',
  Files = 'files',
  Todos = 'todos',
}

/** Every tab the panel shows, in tab bar order. */
export const PANEL_TABS: readonly PanelTab[] = [PanelTab.Agents, PanelTab.Files, PanelTab.Todos]

/** The tab a panel with nothing stored starts on. */
export const FIRST_PANEL_TAB = PanelTab.Agents

function isPanelTab(value: string): value is PanelTab {
  return (PANEL_TABS as readonly string[]).includes(value)
}

/**
 * The stored tab, or Agents when none is stored or this version doesn't have the one that is: a tab from before the
 * panel had three (Tool calls, Subagents, Watchers, Artifacts or Changes, #501), or one a newer version stored.
 */
export function parsePanelTab(value: string | undefined): PanelTab {
  return value !== undefined && isPanelTab(value) ? value : FIRST_PANEL_TAB
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
 * had its own (`UiStateKey.RightPanelTab`, every workspace's starting value), or else Agents. A stored tab the panel
 * no longer has counts as none stored, at either step.
 */
export function activePanelTab(uiState: UiStateValues, workspaceId: string): PanelTab {
  const picked = parsePanelTabSelection(uiState[UiStateKey.RightPanelTabs])[workspaceId]
  return picked ?? parsePanelTab(uiState[UiStateKey.RightPanelTab])
}

/** The UI state that makes `tab` the one `workspaceId`'s right panel shows, keeping every other workspace's. */
export function panelTabEntry(uiState: UiStateValues, workspaceId: string, tab: PanelTab): UiStateEntry {
  const kept = Object.entries(parsePanelTabSelection(uiState[UiStateKey.RightPanelTabs])).filter(
    ([id]) => id !== workspaceId,
  )
  const selection: PanelTabSelection = Object.fromEntries([...kept, [workspaceId, tab]])
  return { key: UiStateKey.RightPanelTabs, value: serializePanelTabSelection(selection) }
}

/** The tab ⌘⌥ and a digit picks: 1 is Agents and 3 is Todos. Undefined for any other digit. */
export function tabForDigit(digit: number): PanelTab | undefined {
  return PANEL_TABS[digit - 1]
}

/** A tab's count: a plain number (`4` agents) or progress (`3/4` todos). */
export type PanelCount = number | { readonly done: number; readonly total: number }

/** How a count reads beside its tab's label, or undefined to show none: a count of zero, or progress out of zero. */
export function formatCount(count: PanelCount): string | undefined {
  if (typeof count === 'number') return count === 0 ? undefined : String(count)
  return count.total === 0 ? undefined : `${String(count.done)}/${String(count.total)}`
}
