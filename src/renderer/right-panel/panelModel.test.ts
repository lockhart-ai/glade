import { describe, expect, it } from 'vitest'
import {
  clampWidth,
  DEFAULT_PANEL_WIDTH,
  formatCount,
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_TABS,
  PanelTab,
  parsePanelTab,
  parsePanelWidth,
  tabForDigit,
  widthBounds,
} from './panelModel'

describe('parsePanelTab', () => {
  it('reads a stored tab, and falls back to Tool calls', () => {
    expect(parsePanelTab('todos')).toBe(PanelTab.Todos)
    expect(parsePanelTab(undefined)).toBe(PanelTab.ToolCalls)
    expect(parsePanelTab('terminal')).toBe(PanelTab.ToolCalls)
  })
})

describe('tabForDigit', () => {
  it('maps 1–5 to the tabs in tab bar order, and nothing else', () => {
    expect([1, 2, 3, 4, 5].map(tabForDigit)).toEqual([...PANEL_TABS])
    expect(PANEL_TABS).toEqual(['tool-calls', 'files', 'todos', 'artifacts', 'subagents'])
    expect(tabForDigit(0)).toBeUndefined()
    expect(tabForDigit(6)).toBeUndefined()
  })
})

describe('widthBounds', () => {
  it('leaves the chat its minimum width', () => {
    expect(widthBounds(1540)).toEqual({ min: MIN_PANEL_WIDTH, max: 1540 - MIN_CHAT_WIDTH })
  })

  it('never goes below the panel’s minimum, even when the chat must shrink', () => {
    // The task card in a 1100px window: 1100 less the outer padding, the sidebar and the gaps.
    expect(widthBounds(1100 - 24 - 300 - 12 - 24 - 12)).toEqual({ min: MIN_PANEL_WIDTH, max: 348 })
    expect(widthBounds(500)).toEqual({ min: MIN_PANEL_WIDTH, max: MIN_PANEL_WIDTH })
    expect(widthBounds(0)).toEqual({ min: MIN_PANEL_WIDTH, max: MIN_PANEL_WIDTH })
  })
})

describe('clampWidth', () => {
  it('holds a width within the bounds, in whole pixels', () => {
    const bounds = { min: 320, max: 800 }
    expect(clampWidth(500.4, bounds)).toBe(500)
    expect(clampWidth(100, bounds)).toBe(320)
    expect(clampWidth(1200, bounds)).toBe(800)
  })
})

describe('parsePanelWidth', () => {
  it('reads a stored width, never below the minimum', () => {
    expect(parsePanelWidth('612')).toBe(612)
    expect(parsePanelWidth('612.6')).toBe(613)
    expect(parsePanelWidth('100')).toBe(MIN_PANEL_WIDTH)
  })

  it('falls back to the default when none is stored, or it isn’t a number', () => {
    expect(parsePanelWidth(undefined)).toBe(DEFAULT_PANEL_WIDTH)
    expect(parsePanelWidth('')).toBe(DEFAULT_PANEL_WIDTH)
    expect(parsePanelWidth('wide')).toBe(DEFAULT_PANEL_WIDTH)
    expect(parsePanelWidth('Infinity')).toBe(DEFAULT_PANEL_WIDTH)
  })
})

describe('formatCount', () => {
  it('shows a number, or progress, and hides zero', () => {
    expect(formatCount(7)).toBe('7')
    expect(formatCount(0)).toBeUndefined()
    expect(formatCount({ done: 3, total: 4 })).toBe('3/4')
    expect(formatCount({ done: 0, total: 4 })).toBe('0/4')
    expect(formatCount({ done: 0, total: 0 })).toBeUndefined()
  })
})
