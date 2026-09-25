import { describe, expect, it } from 'vitest'
import { UiStateKey } from '../../shared/domain'
import { Panel, PANELS } from './panels'
import {
  clampSize,
  DEFAULT_BOTTOM_BAR_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_BOTTOM_BAR_HEIGHT,
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  panelSize,
  parsePanelSize,
  sizeBounds,
} from './panelSize'

describe('panelSize', () => {
  it('stores each panel’s size under its own key, starting at the design’s sizes', () => {
    expect(PANELS.map((panel) => panelSize(panel))).toEqual([
      { key: UiStateKey.SidebarWidth, initial: 300, min: MIN_SIDEBAR_WIDTH, max: MAX_SIDEBAR_WIDTH },
      { key: UiStateKey.RightPanelWidth, initial: 440, min: MIN_PANEL_WIDTH, max: undefined },
      { key: UiStateKey.BottomBarHeight, initial: 300, min: MIN_BOTTOM_BAR_HEIGHT, max: undefined },
    ])
  })

  it('starts every panel within its own limits', () => {
    for (const panel of PANELS) {
      const { initial, min, max } = panelSize(panel)
      expect(initial).toBeGreaterThanOrEqual(min)
      expect(initial).toBeLessThanOrEqual(max ?? Infinity)
    }
  })
})

describe('sizeBounds', () => {
  it('gives a panel the room there is, up to its own maximum', () => {
    expect(sizeBounds(Panel.RightPanel, 1540 - MIN_CHAT_WIDTH)).toEqual({ min: MIN_PANEL_WIDTH, max: 1160 })
    expect(sizeBounds(Panel.BottomBar, 716.4)).toEqual({ min: MIN_BOTTOM_BAR_HEIGHT, max: 716 })
    expect(sizeBounds(Panel.Sidebar, 352)).toEqual({ min: MIN_SIDEBAR_WIDTH, max: 352 })
    expect(sizeBounds(Panel.Sidebar, 1172)).toEqual({ min: MIN_SIDEBAR_WIDTH, max: MAX_SIDEBAR_WIDTH })
  })

  it('never goes below the panel’s minimum, even with no room at all', () => {
    // The right panel in a 1100px window's task card: 1100 less the outer padding, the sidebar, the gaps and the chat.
    expect(sizeBounds(Panel.RightPanel, 1100 - 16 - 300 - 8 - 2 - 24 - MIN_CHAT_WIDTH)).toEqual({
      min: MIN_PANEL_WIDTH,
      max: 370,
    })
    for (const panel of PANELS) {
      const { min } = panelSize(panel)
      expect(sizeBounds(panel, 0)).toEqual({ min, max: min })
      expect(sizeBounds(panel, -200)).toEqual({ min, max: min })
    }
  })
})

describe('clampSize', () => {
  it('holds a size within the bounds, in whole pixels', () => {
    const bounds = { min: 320, max: 800 }
    expect(clampSize(500.4, bounds)).toBe(500)
    expect(clampSize(100, bounds)).toBe(320)
    expect(clampSize(1200, bounds)).toBe(800)
  })
})

describe('parsePanelSize', () => {
  it('reads a stored size, within the panel’s own limits', () => {
    expect(parsePanelSize(Panel.RightPanel, '612')).toBe(612)
    expect(parsePanelSize(Panel.RightPanel, '612.6')).toBe(613)
    expect(parsePanelSize(Panel.RightPanel, '100')).toBe(MIN_PANEL_WIDTH)
    expect(parsePanelSize(Panel.RightPanel, '5000')).toBe(5000)
    expect(parsePanelSize(Panel.Sidebar, '410')).toBe(410)
    expect(parsePanelSize(Panel.Sidebar, '10')).toBe(MIN_SIDEBAR_WIDTH)
    expect(parsePanelSize(Panel.Sidebar, '5000')).toBe(MAX_SIDEBAR_WIDTH)
    expect(parsePanelSize(Panel.BottomBar, '0')).toBe(MIN_BOTTOM_BAR_HEIGHT)
    expect(parsePanelSize(Panel.BottomBar, '640')).toBe(640)
  })

  it('falls back to the default when none is stored, or it isn’t a number', () => {
    for (const value of [undefined, '', 'wide', 'Infinity', 'NaN']) {
      expect(parsePanelSize(Panel.Sidebar, value)).toBe(DEFAULT_SIDEBAR_WIDTH)
      expect(parsePanelSize(Panel.RightPanel, value)).toBe(DEFAULT_PANEL_WIDTH)
      expect(parsePanelSize(Panel.BottomBar, value)).toBe(DEFAULT_BOTTOM_BAR_HEIGHT)
    }
  })
})
