import { describe, expect, it } from 'vitest'
import { parseTerminalSelection, serializeTerminalSelection, terminalTitle, terminalWorkspaceKey } from './terminal'

describe('the terminal selection', () => {
  it('keys a workspace by its id, and no workspace by the empty string', () => {
    expect(terminalWorkspaceKey('w1')).toBe('w1')
    expect(terminalWorkspaceKey(null)).toBe('')
  })

  it('round-trips through its UI state value', () => {
    const selection = { w1: 'a', '': 'n' }
    expect(parseTerminalSelection(serializeTerminalSelection(selection))).toEqual(selection)
  })

  it('is empty when unset, or not an object of picks', () => {
    for (const value of [undefined, '', 'not json', 'null', '[1, 2]', '"w1"', '3']) {
      expect(parseTerminalSelection(value)).toEqual({})
    }
  })

  it('drops an entry that doesn’t name a tab by a string', () => {
    expect(parseTerminalSelection(JSON.stringify({ w1: 'a', w2: 3, w3: null, w4: { id: 'x' } }))).toEqual({ w1: 'a' })
  })
})

describe('terminalTitle', () => {
  it('is the name you gave the tab, or else what runs in it', () => {
    expect(terminalTitle({ name: 'server', process: 'zsh' })).toBe('server')
    expect(terminalTitle({ name: null, process: 'python3' })).toBe('python3')
  })
})
