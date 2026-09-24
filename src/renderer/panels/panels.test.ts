import { describe, expect, it } from 'vitest'
import { UiStateKey } from '../../shared/domain'
import { AppCommandId } from '../../shared/commands'
import { bottomBarIcon, panelIconPath, rightPanelIcon, sidebarIcon } from './panelIcons'
import { collapsedEntry, isCollapsed, Panel, panelDefinition, PANELS, toggledEntry, toggleTitle } from './panels'

describe('panelDefinition', () => {
  it('stores each panel under its own key, with the designs’ names and the keymap’s shortcuts', () => {
    expect(PANELS.map((panel) => panelDefinition(panel))).toEqual([
      {
        key: UiStateKey.SidebarCollapsed,
        collapseLabel: 'Collapse task list',
        showLabel: 'Show task list',
        command: AppCommandId.ToggleSidebar,
        icon: sidebarIcon,
      },
      {
        key: UiStateKey.RightPanelCollapsed,
        collapseLabel: 'Collapse side panel',
        showLabel: 'Show side panel',
        command: AppCommandId.ToggleRightPanel,
        icon: rightPanelIcon,
      },
      {
        key: UiStateKey.BottomBarCollapsed,
        collapseLabel: 'Collapse bottom panel',
        showLabel: 'Show bottom panel',
        command: AppCommandId.ToggleBottomBar,
        icon: bottomBarIcon,
      },
    ])
  })
})

describe('isCollapsed', () => {
  it('is collapsed only when stored so; unset means open', () => {
    const uiState = {
      [UiStateKey.SidebarCollapsed]: 'true',
      [UiStateKey.RightPanelCollapsed]: 'false',
    }

    expect(isCollapsed(uiState, Panel.Sidebar)).toBe(true)
    expect(isCollapsed(uiState, Panel.RightPanel)).toBe(false)
    expect(isCollapsed(uiState, Panel.BottomBar)).toBe(false)
    expect(isCollapsed({ [UiStateKey.BottomBarCollapsed]: 'yes' }, Panel.BottomBar)).toBe(false)
  })
})

describe('collapsedEntry and toggledEntry', () => {
  it('write the panel’s own key', () => {
    expect(collapsedEntry(Panel.BottomBar, true)).toEqual({ key: UiStateKey.BottomBarCollapsed, value: 'true' })
    expect(collapsedEntry(Panel.Sidebar, false)).toEqual({ key: UiStateKey.SidebarCollapsed, value: 'false' })
  })

  it('flip the panel: an open one collapses, a collapsed one opens', () => {
    expect(toggledEntry({}, Panel.Sidebar)).toEqual({ key: UiStateKey.SidebarCollapsed, value: 'true' })
    expect(toggledEntry({ [UiStateKey.RightPanelCollapsed]: 'true' }, Panel.RightPanel)).toEqual({
      key: UiStateKey.RightPanelCollapsed,
      value: 'false',
    })
  })
})

describe('toggleTitle', () => {
  it('names the action, then its shortcut', () => {
    expect(toggleTitle('Collapse task list', '⌘B')).toBe('Collapse task list (⌘B)')
  })
})

describe('panel icons', () => {
  it('are 24-unit Font Awesome icons of one family, told apart by where the line runs', () => {
    for (const icon of [sidebarIcon, rightPanelIcon, bottomBarIcon]) {
      expect(icon.prefix).toBe('fak')
      expect(icon.icon.slice(0, 2)).toEqual([24, 24])
    }
    expect(sidebarIcon.icon[4]).toBe(panelIconPath({ x: 9 }))
    expect(rightPanelIcon.icon[4]).toBe(panelIconPath({ x: 15 }))
    expect(bottomBarIcon.icon[4]).toBe(panelIconPath({ y: 14 }))
  })

  it('draw the stroked outline as filled edges, with no floating-point noise', () => {
    expect(panelIconPath({ x: 9 })).toBe(
      // The outer edge of the 1.8 stroke, clockwise…
      'M6 3.6H18A3.4 3.4 0 0 1 21.4 7V17A3.4 3.4 0 0 1 18 20.4H6A3.4 3.4 0 0 1 2.6 17V7A3.4 3.4 0 0 1 6 3.6Z' +
        // …its inner edge, anticlockwise, which cuts the hole…
        'M6 5.4A1.6 1.6 0 0 0 4.4 7V17A1.6 1.6 0 0 0 6 18.6H18A1.6 1.6 0 0 0 19.6 17V7A1.6 1.6 0 0 0 18 5.4Z' +
        // …and the line down at x = 9.
        'M8.1 5.4H9.9V18.6H8.1V5.4Z',
    )
    expect(panelIconPath({ y: 14 })).toContain('M4.4 13.1H19.6V14.9H4.4V13.1Z')
  })
})
