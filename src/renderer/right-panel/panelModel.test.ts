import { describe, expect, it } from 'vitest'
import { formatCount, PANEL_TABS, PanelTab, parsePanelTab, tabForDigit } from './panelModel'

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

describe('formatCount', () => {
  it('shows a number, or progress, and hides zero', () => {
    expect(formatCount(7)).toBe('7')
    expect(formatCount(0)).toBeUndefined()
    expect(formatCount({ done: 3, total: 4 })).toBe('3/4')
    expect(formatCount({ done: 0, total: 4 })).toBe('0/4')
    expect(formatCount({ done: 0, total: 0 })).toBeUndefined()
  })
})
