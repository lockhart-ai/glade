import { describe, expect, it } from 'vitest'
import { UiStateKey } from '../../shared/domain'
import type { UiStateValues } from '../store/state'
import {
  activePanelTab,
  firstPanelTab,
  formatCount,
  HUB_PANEL_TABS,
  PANEL_TABS,
  PanelTab,
  panelTabEntry,
  panelTabs,
  parsePanelTab,
  parsePanelTabSelection,
  serializePanelTabSelection,
  tabForDigit,
} from './panelModel'

describe('parsePanelTab', () => {
  it('reads a stored tab, and falls back to Tool calls', () => {
    expect(parsePanelTab('todos')).toBe(PanelTab.Todos)
    expect(parsePanelTab(undefined)).toBe(PanelTab.ToolCalls)
    expect(parsePanelTab('terminal')).toBe(PanelTab.ToolCalls)
  })
})

describe('parsePanelTabSelection', () => {
  it('reads a stored selection, dropping entries that are not a known tab', () => {
    expect(parsePanelTabSelection(serializePanelTabSelection({ w1: PanelTab.Todos, w2: PanelTab.Files }))).toEqual({
      w1: 'todos',
      w2: 'files',
    })
    expect(parsePanelTabSelection('{"w1":"todos","w2":"terminal","w3":7}')).toEqual({ w1: 'todos' })
  })

  it('reads empty when unset, not JSON, or JSON that is not a plain object', () => {
    expect(parsePanelTabSelection(undefined)).toEqual({})
    expect(parsePanelTabSelection('not json')).toEqual({})
    expect(parsePanelTabSelection('7')).toEqual({})
    expect(parsePanelTabSelection('null')).toEqual({})
    expect(parsePanelTabSelection('[]')).toEqual({})
  })
})

describe('activePanelTab', () => {
  it("reads a workspace's own choice over the tab stored before each workspace had its own", () => {
    const uiState: UiStateValues = {
      [UiStateKey.RightPanelTab]: 'artifacts',
      [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: PanelTab.Todos }),
    }
    expect(activePanelTab(uiState, 'w1')).toBe(PanelTab.Todos)
  })

  it('falls back to the tab stored before each workspace had its own, for a workspace with no choice', () => {
    const uiState: UiStateValues = {
      [UiStateKey.RightPanelTab]: 'artifacts',
      [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: PanelTab.Todos }),
    }
    expect(activePanelTab(uiState, 'w2')).toBe(PanelTab.Artifacts)
  })

  it('falls back to Tool calls with neither stored', () => {
    expect(activePanelTab({}, 'w1')).toBe(PanelTab.ToolCalls)
  })

  describe('with the todo hub on (P16, #536)', () => {
    const stored = (tab: PanelTab): UiStateValues => ({
      [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: tab }),
    })

    it('starts on Agents, and keeps a tab the three have', () => {
      expect(activePanelTab({}, 'w1', true)).toBe(PanelTab.Agents)
      expect(firstPanelTab(true)).toBe(PanelTab.Agents)
      expect(firstPanelTab(false)).toBe(PanelTab.ToolCalls)
      for (const tab of HUB_PANEL_TABS) expect(activePanelTab(stored(tab), 'w1', true)).toBe(tab)
    })

    it('shows Agents for a workspace left on a tab the hub replaced, leaving what’s stored as it is', () => {
      for (const tab of [
        PanelTab.ToolCalls,
        PanelTab.Subagents,
        PanelTab.Watchers,
        PanelTab.Artifacts,
        PanelTab.Changes,
      ]) {
        const uiState = stored(tab)
        expect(activePanelTab(uiState, 'w1', true)).toBe(PanelTab.Agents)
        // The switch turned off again: the tab it was on.
        expect(activePanelTab(uiState, 'w1')).toBe(tab)
      }
      expect(activePanelTab({ [UiStateKey.RightPanelTab]: 'artifacts' }, 'w2', true)).toBe(PanelTab.Agents)
    })

    it('shows Tool calls, with it off again, for a workspace left on Agents', () => {
      expect(parsePanelTab('agents')).toBe(PanelTab.Agents)
      expect(activePanelTab(stored(PanelTab.Agents), 'w1')).toBe(PanelTab.ToolCalls)
      expect(activePanelTab(stored(PanelTab.Agents), 'w1', true)).toBe(PanelTab.Agents)
    })
  })
})

describe('panelTabs', () => {
  it('is today’s seven with the todo hub off, and Agents · Files · Todos with it on', () => {
    expect(panelTabs(false)).toBe(PANEL_TABS)
    expect(panelTabs(true)).toEqual(['agents', 'files', 'todos'])
    expect(PANEL_TABS).not.toContain(PanelTab.Agents)
  })
})

describe('panelTabEntry', () => {
  it("sets a workspace's tab, keeping every other workspace's", () => {
    const uiState: UiStateValues = { [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: PanelTab.Todos }) }

    const entry = panelTabEntry(uiState, 'w2', PanelTab.Files)

    expect(entry.key).toBe(UiStateKey.RightPanelTabs)
    expect(parsePanelTabSelection(entry.value)).toEqual({ w1: 'todos', w2: 'files' })
  })

  it("replaces a workspace's own earlier choice", () => {
    const uiState: UiStateValues = { [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: PanelTab.Todos }) }

    const entry = panelTabEntry(uiState, 'w1', PanelTab.Files)

    expect(parsePanelTabSelection(entry.value)).toEqual({ w1: 'files' })
  })
})

describe('tabForDigit', () => {
  it('maps 1–7 to the tabs in tab bar order, and nothing else', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((digit) => tabForDigit(digit))).toEqual([...PANEL_TABS])
    expect(PANEL_TABS).toEqual(['tool-calls', 'files', 'todos', 'artifacts', 'subagents', 'watchers', 'changes'])
    expect(tabForDigit(0)).toBeUndefined()
    expect(tabForDigit(8)).toBeUndefined()
  })

  it('maps 1–3 to Agents · Files · Todos with the todo hub on, and 4–7 to nothing', () => {
    expect([1, 2, 3].map((digit) => tabForDigit(digit, true))).toEqual([...HUB_PANEL_TABS])
    expect([0, 4, 5, 6, 7].map((digit) => tabForDigit(digit, true))).toEqual(Array(5).fill(undefined))
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
