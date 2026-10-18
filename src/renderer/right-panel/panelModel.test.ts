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
  parsePanelTabSelection,
  serializePanelTabSelection,
  tabForDigit,
  withoutPanelTabEntry,
} from './panelModel'

describe('the panel’s tabs', () => {
  it('are Agents · Files · Todos, in tab bar order, starting on Agents', () => {
    expect(PANEL_TABS).toEqual(['agents', 'files', 'todos'])
    expect(Object.values(PanelTab)).toEqual([...PANEL_TABS])
    expect(FIRST_PANEL_TAB).toBe(PanelTab.Agents)
  })
})

describe('parsePanelTabSelection', () => {
  it('reads a stored selection, dropping entries that are not a known tab', () => {
    expect(parsePanelTabSelection(serializePanelTabSelection({ t1: PanelTab.Todos, t2: PanelTab.Files }))).toEqual({
      t1: 'todos',
      t2: 'files',
    })
    expect(parsePanelTabSelection('{"t1":"todos","t2":"terminal","t3":7}')).toEqual({ t1: 'todos' })
  })

  it('drops a task left on a tab the panel no longer has, keeping the others', () => {
    const stored = JSON.stringify({
      t1: 'tool-calls',
      t2: 'subagents',
      t3: 'watchers',
      t4: 'artifacts',
      t5: 'changes',
      t6: 'files',
    })
    expect(parsePanelTabSelection(stored)).toEqual({ t6: 'files' })
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
  it("reads a task's own choice", () => {
    const uiState: UiStateValues = {
      [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ t1: PanelTab.Todos, t2: PanelTab.Files }),
    }
    expect(activePanelTab(uiState, 't1')).toBe(PanelTab.Todos)
    expect(activePanelTab(uiState, 't2')).toBe(PanelTab.Files)
  })

  it("falls back to the panel's first tab for a task with none remembered", () => {
    expect(activePanelTab({}, 't1')).toBe(PanelTab.Agents)
    expect(
      activePanelTab({ [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ t2: PanelTab.Todos }) }, 't1'),
    ).toBe(PanelTab.Agents)
  })

  it('keeps a tab the three have', () => {
    for (const tab of PANEL_TABS) {
      expect(activePanelTab({ [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ t1: tab }) }, 't1')).toBe(tab)
    }
  })

  it.each(['tool-calls', 'subagents', 'watchers', 'artifacts', 'changes', 'no-such-tab'])(
    "shows the panel's first tab for a task left on %s, a tab it no longer has",
    (removed) => {
      expect(activePanelTab({ [UiStateKey.RightPanelTabs]: JSON.stringify({ t1: removed }) }, 't1')).toBe(
        FIRST_PANEL_TAB,
      )
    },
  )
})

describe('panelTabEntry', () => {
  it("sets a task's tab, keeping every other task's", () => {
    const uiState: UiStateValues = { [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ t1: PanelTab.Todos }) }

    const entry = panelTabEntry(uiState, 't2', PanelTab.Files)

    expect(entry.key).toBe(UiStateKey.RightPanelTabs)
    expect(parsePanelTabSelection(entry.value)).toEqual({ t1: 'todos', t2: 'files' })
  })

  it("replaces a task's own earlier choice", () => {
    const uiState: UiStateValues = { [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ t1: PanelTab.Todos }) }

    const entry = panelTabEntry(uiState, 't1', PanelTab.Files)

    expect(parsePanelTabSelection(entry.value)).toEqual({ t1: 'files' })
  })

  it('writes no tab the panel no longer has: a task left on one is dropped from what’s stored', () => {
    const uiState: UiStateValues = { [UiStateKey.RightPanelTabs]: '{"t1":"artifacts","t2":"files"}' }

    expect(panelTabEntry(uiState, 't3', PanelTab.Todos).value).toBe('{"t2":"files","t3":"todos"}')
  })
})

describe('withoutPanelTabEntry', () => {
  it("drops a task's entry, keeping every other task's", () => {
    const uiState: UiStateValues = {
      [UiStateKey.RightPanelTabs]: serializePanelTabSelection({ t1: PanelTab.Files, t2: PanelTab.Todos }),
    }

    const entry = withoutPanelTabEntry(uiState, 't1')

    expect(entry).toEqual({ key: UiStateKey.RightPanelTabs, value: '{"t2":"todos"}' })
  })

  it('is null for a task with no entry: nothing to write', () => {
    expect(withoutPanelTabEntry({}, 't1')).toBeNull()
    expect(withoutPanelTabEntry({ [UiStateKey.RightPanelTabs]: '{"t2":"files"}' }, 't1')).toBeNull()
    // A task whose entry names a removed tab isn't stored to drop either.
    expect(withoutPanelTabEntry({ [UiStateKey.RightPanelTabs]: '{"t1":"artifacts"}' }, 't1')).toBeNull()
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
