import { describe, expect, it } from 'vitest'
import { UiStateKey } from '../../shared/domain'
import { sampleTerminalTab } from '../store/test-bridge'
import { WindowCommandId } from '../../shared/commands'
import { resolveKeymap, DEFAULT_KEYMAP, type KeyPress } from '../../shared/keymap'
import {
  activeTerminalTab,
  commandToPaste,
  cycledTab,
  isAppKey,
  shownTerminalTabs,
  terminalSelectionEntry,
  unseenOutput,
} from './terminalModel'

function keys(key: string, code: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }
}

describe('activeTerminalTab', () => {
  const tabs = [
    sampleTerminalTab('a', { workspaceId: 'w1' }),
    sampleTerminalTab('other', { workspaceId: 'w2' }),
    sampleTerminalTab('b', { workspaceId: 'w1' }),
    sampleTerminalTab('none'),
  ]
  const picked = (selection: Record<string, string>) => ({
    [UiStateKey.TerminalSelection]: JSON.stringify(selection),
  })

  it('is the tab last picked in the workspace', () => {
    expect(activeTerminalTab(tabs, picked({ w1: 'b', w2: 'other' }), 'w1')?.id).toBe('b')
    expect(activeTerminalTab(tabs, picked({ w1: 'b', w2: 'other' }), 'w2')?.id).toBe('other')
  })

  it('is the workspace’s first tab while none was picked there, or the one picked has gone', () => {
    expect(activeTerminalTab(tabs, {}, 'w1')?.id).toBe('a')
    expect(activeTerminalTab(tabs, picked({ w1: 'gone' }), 'w1')?.id).toBe('a')
    expect(activeTerminalTab(tabs, { [UiStateKey.TerminalSelection]: 'not json' }, 'w1')?.id).toBe('a')
    expect(activeTerminalTab([], {}, 'w1')).toBeUndefined()
  })

  it('is never another workspace’s tab, even one picked for this one', () => {
    expect(activeTerminalTab(tabs, picked({ w1: 'other' }), 'w1')?.id).toBe('a')
    expect(activeTerminalTab(tabs, {}, 'w3')).toBeUndefined()
  })

  it('is a tab of none, with no workspace showing', () => {
    expect(activeTerminalTab(tabs, picked({ '': 'none' }), null)?.id).toBe('none')
    expect(activeTerminalTab(tabs, {}, null)?.id).toBe('none')
  })
})

describe('shownTerminalTabs', () => {
  it('is the workspace’s tabs in order, or none’s with no workspace', () => {
    const tabs = [
      sampleTerminalTab('a', { workspaceId: 'w1' }),
      sampleTerminalTab('x', { workspaceId: 'w2' }),
      sampleTerminalTab('b', { workspaceId: 'w1' }),
      sampleTerminalTab('n'),
    ]
    expect(shownTerminalTabs(tabs, 'w1').map(({ id }) => id)).toEqual(['a', 'b'])
    expect(shownTerminalTabs(tabs, null).map(({ id }) => id)).toEqual(['n'])
    expect(shownTerminalTabs(tabs, 'w3')).toEqual([])
  })
})

describe('terminalSelectionEntry', () => {
  it('picks a tab for one workspace, keeping the others’ picks', () => {
    const uiState = { [UiStateKey.TerminalSelection]: JSON.stringify({ w1: 'a', w2: 'x' }) }
    const entry = terminalSelectionEntry(uiState, 'w1', 'b')
    expect(entry.key).toBe(UiStateKey.TerminalSelection)
    expect(JSON.parse(entry.value)).toEqual({ w1: 'b', w2: 'x' })
    expect(JSON.parse(terminalSelectionEntry(uiState, null, 'n').value)).toEqual({ w1: 'a', w2: 'x', '': 'n' })
  })

  it('forgets a workspace’s pick with null, and starts afresh from none or a broken value', () => {
    const uiState = { [UiStateKey.TerminalSelection]: JSON.stringify({ w1: 'a', w2: 'x' }) }
    expect(JSON.parse(terminalSelectionEntry(uiState, 'w2', null).value)).toEqual({ w1: 'a' })
    expect(JSON.parse(terminalSelectionEntry({}, 'w1', 'a').value)).toEqual({ w1: 'a' })
    expect(JSON.parse(terminalSelectionEntry({ [UiStateKey.TerminalSelection]: '[1]' }, 'w1', 'a').value)).toEqual({
      w1: 'a',
    })
  })
})

describe('isAppKey', () => {
  it('leaves every ⌘ key and the terminal’s shortcuts to the app', () => {
    expect(isAppKey(DEFAULT_KEYMAP, keys('j', 'KeyJ', { metaKey: true }))).toBe(true)
    expect(isAppKey(DEFAULT_KEYMAP, keys('`', 'Backquote', { ctrlKey: true }))).toBe(true)
    expect(isAppKey(DEFAULT_KEYMAP, keys('Tab', 'Tab', { ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('sends everything else to the shell, ⌃C included, and modifiers alone', () => {
    expect(isAppKey(DEFAULT_KEYMAP, keys('c', 'KeyC', { ctrlKey: true }))).toBe(false)
    expect(isAppKey(DEFAULT_KEYMAP, keys('l', 'KeyL'))).toBe(false)
    expect(isAppKey(DEFAULT_KEYMAP, keys('Control', 'ControlLeft', { ctrlKey: true }))).toBe(false)
  })

  it('sends ⌥↑ / ⌥↓ to the shell, not to Next / previous task, however they’re bound', () => {
    expect(isAppKey(DEFAULT_KEYMAP, keys('ArrowDown', 'ArrowDown', { altKey: true }))).toBe(false)
    expect(isAppKey(DEFAULT_KEYMAP, keys('ArrowUp', 'ArrowUp', { altKey: true }))).toBe(false)
    const rebound = resolveKeymap({ [WindowCommandId.NextTask]: 'Ctrl+Alt+J' })
    expect(isAppKey(rebound, keys('∆', 'KeyJ', { ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('follows the keymap as you’ve bound it', () => {
    const rebound = resolveKeymap({ [WindowCommandId.FocusTerminal]: 'Ctrl+Alt+T' })
    expect(isAppKey(rebound, keys('`', 'Backquote', { ctrlKey: true }))).toBe(false)
    expect(isAppKey(rebound, keys('t', 'KeyT', { ctrlKey: true, altKey: true }))).toBe(true)
  })
})

describe('cycledTab', () => {
  const ids = ['a', 'b', 'c']

  it('goes to the next tab or the one before, round from the ends', () => {
    expect(cycledTab(ids, 'a', 1)).toBe('b')
    expect(cycledTab(ids, 'c', 1)).toBe('a')
    expect(cycledTab(ids, 'a', -1)).toBe('c')
  })

  it('goes to the first when the tab showing has gone', () => {
    expect(cycledTab(ids, 'gone', 1)).toBe('a')
  })
})

describe('unseenOutput', () => {
  it('is all of output from where the window’s output ends or after', () => {
    expect(unseenOutput(10, 'hello', 10)).toBe('hello')
    expect(unseenOutput(12, 'hello', 10)).toBe('hello')
  })

  it('is none of output the window already has, and the rest of output it has part of', () => {
    expect(unseenOutput(0, 'hello', 10)).toBe('')
    expect(unseenOutput(8, 'hello', 10)).toBe('llo')
  })
})

describe('commandToPaste', () => {
  it('drops the line break that would run the command', () => {
    expect(commandToPaste('npm test\n')).toBe('npm test')
    expect(commandToPaste('for f in *; do\n  echo "$f"\ndone \n\n')).toBe('for f in *; do\n  echo "$f"\ndone')
  })
})
