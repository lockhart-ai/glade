// The right panel's state, as it's stored in UI state: its selected tab, per task (#689; was per workspace, #432).
// (Whether it's collapsed, and its width, are `../panels`, with the other panels'.)
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import type { UiStateValues } from '../store/state'

/**
 * The right panel's tabs (P16, #491), in the order the tab bar shows them (and ⌘⌥1–3 picks them): Todos is what the
 * work produced (each todo with its files, links and changes), Agents is what's happening (every agent's tool calls
 * and watchers), and Files is the workspace's files.
 */
export enum PanelTab {
  Todos = 'todos',
  Agents = 'agents',
  Files = 'files',
}

/** Every tab the panel shows, in tab bar order. */
export const PANEL_TABS: readonly PanelTab[] = [PanelTab.Todos, PanelTab.Agents, PanelTab.Files]

/** The tab a panel with nothing stored starts on (#686 moves this to Todos with the tabs' new order). */
export const FIRST_PANEL_TAB = PanelTab.Todos

function isPanelTab(value: string): value is PanelTab {
  return (PANEL_TABS as readonly string[]).includes(value)
}

/**
 * The tab each task's right panel shows, as the `right_panel_tabs` UI state keeps it: from a task's id to its tab.
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
 * The tab a task's right panel shows: the one last picked there, or else the panel's first tab (Todos, #686) when
 * none is remembered yet. A stored tab the panel no longer has (one from before the panel had three, #501, or from a
 * newer version) counts as none stored.
 */
export function activePanelTab(uiState: UiStateValues, taskId: string): PanelTab {
  return parsePanelTabSelection(uiState[UiStateKey.RightPanelTabs])[taskId] ?? FIRST_PANEL_TAB
}

/** The UI state that makes `tab` the one `taskId`'s right panel shows, keeping every other task's. */
export function panelTabEntry(uiState: UiStateValues, taskId: string, tab: PanelTab): UiStateEntry {
  const kept = Object.entries(parsePanelTabSelection(uiState[UiStateKey.RightPanelTabs])).filter(
    ([id]) => id !== taskId,
  )
  const selection: PanelTabSelection = Object.fromEntries([...kept, [taskId, tab]])
  return { key: UiStateKey.RightPanelTabs, value: serializePanelTabSelection(selection) }
}

/**
 * The UI state that drops `taskId`'s remembered tab, keeping every other task's, for when the task is deleted
 * (#689). Null when it has none: nothing to write.
 */
export function withoutPanelTabEntry(uiState: UiStateValues, taskId: string): UiStateEntry | null {
  const selection = parsePanelTabSelection(uiState[UiStateKey.RightPanelTabs])
  if (!(taskId in selection)) return null
  const kept = Object.entries(selection).filter(([id]) => id !== taskId)
  return { key: UiStateKey.RightPanelTabs, value: serializePanelTabSelection(Object.fromEntries(kept)) }
}

/** The tab ⌘⌥ and a digit picks: 1 is Todos and 3 is Files. Undefined for any other digit. */
export function tabForDigit(digit: number): PanelTab | undefined {
  return PANEL_TABS[digit - 1]
}

/**
 * A task's id to `true`, for the ones whose Files header is collapsed (#764): a set kept in `files_header_collapsed`
 * UI state, as `right_panel_tabs` keeps the selected tab, one entry per task that has it collapsed.
 */
type FilesHeaderCollapsedSelection = Readonly<Record<string, true>>

function parseFilesHeaderCollapsed(value: string | undefined): FilesHeaderCollapsedSelection {
  if (value === undefined) return {}
  let json: unknown
  try {
    json = JSON.parse(value)
  } catch {
    return {}
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return {}
  return Object.fromEntries(
    Object.entries(json)
      .filter(([, collapsed]) => collapsed === true)
      .map(([id]) => [id, true]),
  )
}

/** Whether a task's Files tab header is collapsed, as it was last left (#764): false for a task with no entry. */
export function isFilesHeaderCollapsed(uiState: UiStateValues, taskId: string): boolean {
  return parseFilesHeaderCollapsed(uiState[UiStateKey.FilesHeaderCollapsed])[taskId] === true
}

/** The UI state that collapses or shows `taskId`'s Files header, keeping every other task's. */
export function filesHeaderCollapsedEntry(uiState: UiStateValues, taskId: string, collapsed: boolean): UiStateEntry {
  const kept = Object.entries(parseFilesHeaderCollapsed(uiState[UiStateKey.FilesHeaderCollapsed])).filter(
    ([id]) => id !== taskId,
  )
  const selection: FilesHeaderCollapsedSelection = Object.fromEntries(collapsed ? [...kept, [taskId, true]] : kept)
  return { key: UiStateKey.FilesHeaderCollapsed, value: JSON.stringify(selection) }
}

/**
 * The UI state that drops `taskId`'s remembered Files header state, keeping every other task's, for when the task is
 * deleted. Null when it has none collapsed: nothing to write.
 */
export function withoutFilesHeaderCollapsedEntry(uiState: UiStateValues, taskId: string): UiStateEntry | null {
  const selection = parseFilesHeaderCollapsed(uiState[UiStateKey.FilesHeaderCollapsed])
  if (!(taskId in selection)) return null
  const kept = Object.entries(selection).filter(([id]) => id !== taskId)
  return { key: UiStateKey.FilesHeaderCollapsed, value: JSON.stringify(Object.fromEntries(kept)) }
}

/** A tab's count: a plain number (`4` agents) or progress (`3/4` todos). */
export type PanelCount = number | { readonly done: number; readonly total: number }

/** How a count reads beside its tab's label, or undefined to show none: a count of zero, or progress out of zero. */
export function formatCount(count: PanelCount): string | undefined {
  if (typeof count === 'number') return count === 0 ? undefined : String(count)
  return count.total === 0 ? undefined : `${String(count.done)}/${String(count.total)}`
}
