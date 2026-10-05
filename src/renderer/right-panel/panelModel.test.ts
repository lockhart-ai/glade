import { describe, expect, it } from 'vitest'
import { UiStateKey } from '../../shared/domain'
import type { UiStateValues } from '../store/state'
import {
  activePanelTab,
  FIRST_PANEL_TAB,
  formatCount,
  PANEL_TABS,
  PanelTab,
  panelTabEntry,
  parsePanelTab,
  parsePanelTabSelection,
  serializePanelTabSelection,
  tabForDigit,
} from './panelModel'

/** The tabs the panel had before it had three (#501), as a database from before the update may still store them. */
const REMOVED_TABS = ['tool-calls', 'subagents', 'watchers', 'artifacts', 'changes']

describe('the panel’s tabs', () => {
  it('are Agents · Files · Todos, in tab bar order, starting on Agents', () => {
    expect(PANEL_TABS).toEqual(['agents', 'files', 'todos'])
    expect(Object.values(PanelTab)).toEqual([...PANEL_TABS])
    expect(FIRST_PANEL_TAB).toBe(PanelTab.Agents)
  })
})

describe('parsePanelTab', () => {
  it('reads a stored tab, and falls back to Agents', () => {
    expect(parsePanelTab('todos')).toBe(PanelTab.Todos)
    expect(parsePanelTab('agents')).toBe(PanelTab.Agents)
    expect(parsePanelTab(undefined)).toBe(PanelTab.Agents)
    expect(parsePanelTab('terminal')).toBe(PanelTab.Agents)
  })

  it.each(REMOVED_TABS)('reads %s, a tab the panel no longer has, as Agents', (removed) => {
    expect(parsePanelTab(removed)).toBe(PanelTab.Agents)
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

  it('drops a workspace left on a tab the panel no longer has, keeping the others', () => {
    const stored = JSON.stringify({
      w1: 'tool-calls',
      w2: 'subagents',
      w3: 'watchers',
      w4: 'artifacts',
      w5: 'changes',
      w6: 'files',
    })
    expect(parsePanelTabSelection(stored)).toEqual({ w6: 'files' })
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
      [UiStateKey.RightPanelTab]: 'files',
      [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: PanelTab.Todos }),
    }
    expect(activePanelTab(uiState, 'w1')).toBe(PanelTab.Todos)
  })

  it('falls back to the tab stored before each workspace had its own, for a workspace with no choice', () => {
    const uiState: UiStateValues = {
      [UiStateKey.RightPanelTab]: 'files',
      [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: PanelTab.Todos }),
    }
    expect(activePanelTab(uiState, 'w2')).toBe(PanelTab.Files)
  })

  it('falls back to Agents with neither stored', () => {
    expect(activePanelTab({}, 'w1')).toBe(PanelTab.Agents)
  })

  it('keeps a tab the three have', () => {
    for (const tab of PANEL_TABS) {
      expect(activePanelTab({ [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ w1: tab }) }, 'w1')).toBe(tab)
    }
  })

  it.each(REMOVED_TABS)('shows Agents for a workspace left on %s, however it was stored', (removed) => {
    // Its own choice, from when each workspace had one.
    expect(activePanelTab({ [UiStateKey.RightPanelTabs]: JSON.stringify({ w1: removed }) }, 'w1')).toBe(PanelTab.Agents)
    // The one tab every workspace shared before that.
    expect(activePanelTab({ [UiStateKey.RightPanelTab]: removed }, 'w1')).toBe(PanelTab.Agents)
    // Both, and a removed choice doesn't hide a tab the panel still has behind it.
    expect(
      activePanelTab(
        { [UiStateKey.RightPanelTab]: 'todos', [UiStateKey.RightPanelTabs]: JSON.stringify({ w1: removed }) },
        'w1',
      ),
    ).toBe(PanelTab.Todos)
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

  it('writes no tab the panel no longer has: a workspace left on one is dropped from what’s stored', () => {
    const uiState: UiStateValues = { [UiStateKey.RightPanelTabs]: '{"w1":"artifacts","w2":"files"}' }

    expect(panelTabEntry(uiState, 'w3', PanelTab.Todos).value).toBe('{"w2":"files","w3":"todos"}')
  })
})

describe('tabForDigit', () => {
  it('maps 1–3 to Agents · Files · Todos, and nothing else', () => {
    expect([1, 2, 3].map((digit) => tabForDigit(digit))).toEqual([...PANEL_TABS])
    expect([0, 4, 5, 6, 7, 8].map((digit) => tabForDigit(digit))).toEqual(Array(6).fill(undefined))
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
