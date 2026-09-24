import { describe, expect, it } from 'vitest'
import { UiStateKey } from '../../shared/domain'
import { sampleTerminalTab } from '../store/test-bridge'
import {
  activeTerminalTab,
  commandToPaste,
  cycledTab,
  isAppKey,
  TerminalShortcut,
  terminalShortcut,
  unseenOutput,
  type ShortcutKeys,
} from './terminalModel'

function keys(code: string, modifiers: Partial<ShortcutKeys> = {}): ShortcutKeys {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }
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

describe('terminalShortcut', () => {
  it.each([
    ['⌃`', keys('Backquote', { ctrlKey: true }), TerminalShortcut.Focus],
    ['⌘T', keys('KeyT', { metaKey: true }), TerminalShortcut.NewTab],
    ['⌃⇥', keys('Tab', { ctrlKey: true }), TerminalShortcut.NextTab],
    ['⌃⇧⇥', keys('Tab', { ctrlKey: true, shiftKey: true }), TerminalShortcut.PreviousTab],
    ['⌘K', keys('KeyK', { metaKey: true }), TerminalShortcut.Clear],
    ['⌘W', keys('KeyW', { metaKey: true }), TerminalShortcut.Close],
  ])('reads %s', (_keys, event, shortcut) => {
    expect(terminalShortcut(event)).toBe(shortcut)
  })

  it.each([
    ['⌃C, which goes to the shell', keys('KeyC', { ctrlKey: true })],
    ['⌘⇧K, Compact context', keys('KeyK', { metaKey: true, shiftKey: true })],
    ['⌃⇧`', keys('Backquote', { ctrlKey: true, shiftKey: true })],
    ['⌥⌘T', keys('KeyT', { metaKey: true, altKey: true })],
    ['⌃⌘T', keys('KeyT', { metaKey: true, ctrlKey: true })],
    ['⌘J, a panel shortcut', keys('KeyJ', { metaKey: true })],
    ['a plain T', keys('KeyT')],
  ])('reads nothing from %s', (_keys, event) => {
    expect(terminalShortcut(event)).toBeNull()
  })
})

describe('isAppKey', () => {
  it('leaves every ⌘ key and the terminal’s shortcuts to the app', () => {
    expect(isAppKey(keys('KeyJ', { metaKey: true }))).toBe(true)
    expect(isAppKey(keys('Tab', { ctrlKey: true }))).toBe(true)
  })

  it('sends everything else to the shell, ⌃C included', () => {
    expect(isAppKey(keys('KeyC', { ctrlKey: true }))).toBe(false)
    expect(isAppKey(keys('KeyL'))).toBe(false)
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
