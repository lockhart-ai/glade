// The three collapsible panels around the chat (the sidebar, the right panel and the bottom bar), and whether each is
// collapsed, as it's stored in UI state. Every toggle (a panel's button, its shortcut, a reopen button) goes through
// here, so they all read and write the same persisted state.
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { AppCommandId, commandHint } from '../../shared/commands'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import type { UiStateValues } from '../store/state'
import { bottomBarIcon, rightPanelIcon, sidebarIcon } from './panelIcons'

export enum Panel {
  /** The task list, down the left of the window. */
  Sidebar = 'sidebar',
  /** The task card's tabbed panel, beside the chat. */
  RightPanel = 'right-panel',
  /** The terminal bar along the bottom of the window. */
  BottomBar = 'bottom-bar',
}

/** Every panel, left to right then bottom. */
export const PANELS: readonly Panel[] = Object.values(Panel)

/** A panel's toggle, as its button and shortcut show it. */
export interface PanelDefinition {
  /** Where whether it's collapsed is stored. */
  readonly key: UiStateKey
  /** The button's name while the panel is open (the designs' names). */
  readonly collapseLabel: string
  /** The button's name while the panel is collapsed. */
  readonly showLabel: string
  /** The shortcut that toggles it, as the tooltip shows it (docs/keymap.md). */
  readonly shortcut: string
  readonly icon: IconDefinition
}

/** Each panel's toggle. */
export function panelDefinition(panel: Panel): PanelDefinition {
  switch (panel) {
    case Panel.Sidebar:
      return {
        key: UiStateKey.SidebarCollapsed,
        collapseLabel: 'Collapse task list',
        showLabel: 'Show task list',
        shortcut: commandHint(AppCommandId.ToggleSidebar),
        icon: sidebarIcon,
      }
    case Panel.RightPanel:
      return {
        key: UiStateKey.RightPanelCollapsed,
        collapseLabel: 'Collapse side panel',
        showLabel: 'Show side panel',
        shortcut: commandHint(AppCommandId.ToggleRightPanel),
        icon: rightPanelIcon,
      }
    case Panel.BottomBar:
      return {
        key: UiStateKey.BottomBarCollapsed,
        collapseLabel: 'Collapse bottom panel',
        showLabel: 'Show bottom panel',
        shortcut: commandHint(AppCommandId.ToggleBottomBar),
        icon: bottomBarIcon,
      }
  }
}

/** Whether a panel is collapsed. Unset (or anything but `'true'`) means open. */
export function isCollapsed(uiState: UiStateValues, panel: Panel): boolean {
  return uiState[panelDefinition(panel).key] === 'true'
}

/** The UI state that collapses or opens a panel. */
export function collapsedEntry(panel: Panel, collapsed: boolean): UiStateEntry {
  return { key: panelDefinition(panel).key, value: String(collapsed) }
}

/** The UI state that flips a panel: collapses it when it's open, opens it when it's collapsed. */
export function toggledEntry(uiState: UiStateValues, panel: Panel): UiStateEntry {
  return collapsedEntry(panel, !isCollapsed(uiState, panel))
}

/** A toggle's tooltip: its name and its shortcut, e.g. `Collapse task list (⌘B)`. */
export function toggleTitle(label: string, shortcut: string): string {
  return `${label} (${shortcut})`
}
