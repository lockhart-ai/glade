import { describe, expect, it } from 'vitest'
import { UiStateKey } from '../../shared/domain'
import { sampleTerminalTab } from '../store/test-bridge'
import { WindowCommandId } from '../../shared/commands'
import { resolveKeymap, DEFAULT_KEYMAP, type KeyPress } from '../../shared/keymap'
import { activeTerminalTab, commandToPaste, cycledTab, isAppKey, unseenOutput } from './terminalModel'

function keys(key: string, code: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }
}

describe('activeTerminalTab', () => {
  const tabs = [sampleTerminalTab('a'), sampleTerminalTab('b')]

  it('is the tab last picked', () => {
    expect(activeTerminalTab(tabs, { [UiStateKey.TerminalTab]: 'b' })?.id).toBe('b')
  })

  it('is the first tab while none was picked, or the one picked has gone', () => {
    expect(activeTerminalTab(tabs, {})?.id).toBe('a')
    expect(activeTerminalTab(tabs, { [UiStateKey.TerminalTab]: 'gone' })?.id).toBe('a')
    expect(activeTerminalTab([], {})).toBeUndefined()
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
