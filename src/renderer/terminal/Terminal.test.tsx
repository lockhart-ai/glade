import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType, type TerminalAttachResponse } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { parseTerminalSelection, type TerminalTab } from '../../shared/terminal'
import { refuse, sampleTerminalTab, sampleWorkspace, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { WindowCommandId } from '../../shared/commands'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { requestClose } from '../commands/closeRequest'
import { Terminal } from './Terminal'
import { screens, terminalFont, type FakeScreen } from './test-screen'

vi.mock('./screen', () => import('./test-screen'))

/** The ResizeObserver callbacks the screens registered, to fire as a resized card would. */
let observed: (() => void)[] = []

beforeEach(() => {
  screens.length = 0
  terminalFont.loading = Promise.resolve()
  observed = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observed.push(callback)
      }
      observe = (): void => undefined
      disconnect = (): void => undefined
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A tab of the workspace the window shows, `w1`. */
function tab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return sampleTerminalTab(id, { workspaceId: 'w1', ...overrides })
}

/** The tab the store has picked for the workspace showing. */
function pickedTab(store: StoreWrapper['store']): string | undefined {
  const { uiState, selectedWorkspaceId } = store.getState()
  return parseTerminalSelection(uiState[UiStateKey.TerminalSelection])[selectedWorkspaceId ?? '']
}

async function renderTerminal(
  main: Partial<FakeMain> = {},
  overrides: Partial<FakeHandlers> = {},
): Promise<StoreWrapper & { calls: string[] }> {
  const calls: string[] = []
  const wrapper = storeWrapper(
    {
      terminalTabs: [tab('a'), tab('b')],
      terminalOutput: { a: '$ echo hi\r\nhi\r\n$ ' },
      terminalCalls: calls,
      ...main,
    },
    overrides,
  )
  await act(() => wrapper.store.getState().hydrate())
  render(<Terminal />, { wrapper: wrapper.wrapper })
  await act(() => Promise.resolve())
  return { ...wrapper, calls }
}

function screenOf(index: number): FakeScreen {
  const found = screens[index]
  if (found === undefined) throw new Error(`No screen ${String(index)}`)
  return found
}

function screenElements(): HTMLElement[] {
  return screen.getAllByTestId('terminal-screen')
}

describe('Terminal', () => {
  it('says how to start a terminal while there is none', async () => {
    await renderTerminal({ terminalTabs: [] })

    expect(screen.getByText('No terminal open. Start one with + or ⌘T.')).toBeInTheDocument()
    expect(screens).toEqual([])
  })

  it('shows each tab’s screen with its output so far, the tab showing on top', async () => {
    const { calls } = await renderTerminal()

    expect(screenElements().map((element) => element.dataset.active)).toEqual(['true', 'false'])
    expect(screenOf(0).container).toBe(screenElements()[0])
    expect(screenOf(0).shown).toBe('$ echo hi\r\nhi\r\n$ ')
    expect(screenOf(1).shown).toBe('')
    expect(calls).toEqual(['attach a 80x24', 'attach b 80x24'])
  })

  it('shows output as it comes, and what came while the output so far loaded, once', async () => {
    let answer: (response: TerminalAttachResponse) => void = () => undefined
    const { fake } = await renderTerminal(
      { terminalTabs: [tab('a')] },
      {
        [CommandName.TerminalAttach]: () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      },
    )
    fake.emit({ type: EventType.TerminalOutput, tabId: 'a', offset: 3, data: 'lo\r\n' })
    fake.emit({ type: EventType.TerminalOutput, tabId: 'a', offset: 7, data: '$ ' })

    await act(async () => {
      answer({ output: 'hello\r\n', end: 7 })
      await Promise.resolve()
    })
    fake.emit({ type: EventType.TerminalOutput, tabId: 'a', offset: 9, data: 'ls' })

    expect(screenOf(0).shown).toBe('hello\r\n$ ls')
  })

  it('clears a tab’s screen when main clears its output', async () => {
    const { fake } = await renderTerminal()

    fake.emit({ type: EventType.TerminalCleared, tabId: 'a' })

    expect(screenOf(0).clears).toBe(1)
    expect(screenOf(0).shown).toBe('')
  })

  it('types into the shell, and keeps the shell’s terminal the size of the card', async () => {
    const { calls } = await renderTerminal()
    calls.length = 0

    screenOf(0).type('ls\r')
    screenOf(0).resize({ cols: 120, rows: 30 })
    const fits = screenOf(0).fits
    for (const callback of observed) callback()
    await act(() => Promise.resolve())

    expect(calls).toEqual(['write a ls\r', 'resize a 120x30'])
    expect(screenOf(0).fits).toBe(fits + 1)
  })

  it('shows a toast when the shell can’t be started, or typed into', async () => {
    await renderTerminal(
      { terminalTabs: [tab('a')] },
      {
        [CommandName.TerminalAttach]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'posix_spawnp failed.')),
        [CommandName.TerminalWrite]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No terminal tab a')),
      },
    )
    expect(await screen.findByText('posix_spawnp failed.')).toBeInTheDocument()

    screenOf(0).type('x')

    expect(await screen.findByText('No terminal tab a')).toBeInTheDocument()
  })

  it('takes the focus when asked, in the tab showing', async () => {
    const { store } = await renderTerminal()
    expect(screenOf(0).focuses).toBe(0)

    await act(() => store.getState().selectTerminal('b'))

    expect(screenElements().map((element) => element.dataset.active)).toEqual(['false', 'true'])
    expect(screenOf(1).focuses).toBe(1)
    expect(screenOf(0).focuses).toBe(0)
  })

  it('pastes a command at the prompt of its tab, once, with the focus', async () => {
    const { store, calls } = await renderTerminal()
    calls.length = 0

    await act(() => store.getState().runInTerminal('npm test\n'))

    expect(calls).toEqual(['write a npm test'])
    expect(screenOf(0).focuses).toBe(1)
    expect(store.getState().terminalPaste).toBeNull()
  })

  it('goes round the tabs with ⌃⇥ and ⌃⇧⇥ and clears with ⌘K, from the terminal', async () => {
    const { store, calls } = await renderTerminal()
    const [first] = screenElements()
    if (first === undefined) throw new Error('No screen')

    fireEvent.keyDown(first, { code: 'Tab', key: 'Tab', ctrlKey: true })
    await act(() => Promise.resolve())
    expect(pickedTab(store)).toBe('b')
    fireEvent.keyDown(first, { code: 'Tab', key: 'Tab', ctrlKey: true, shiftKey: true })
    await act(() => Promise.resolve())
    expect(pickedTab(store)).toBe('a')

    fireEvent.keyDown(first, { code: 'KeyK', key: 'k', metaKey: true })
    await act(() => Promise.resolve())
    expect(calls).toContain('clear a')
  })

  it('follows the keymap as you’ve bound it', async () => {
    const { store, calls } = await renderTerminal({
      settings: { ...DEFAULT_SETTINGS, keyBindings: { [WindowCommandId.ClearTerminal]: 'Ctrl+L' } },
    })
    const [first] = screenElements()
    if (first === undefined) throw new Error('No screen')

    expect(fireEvent.keyDown(first, { code: 'KeyK', key: 'k', metaKey: true })).toBe(true)
    fireEvent.keyDown(first, { code: 'KeyL', key: 'l', ctrlKey: true })
    await act(() => Promise.resolve())

    expect(calls).toEqual(['attach a 80x24', 'attach b 80x24', 'clear a'])
    expect(screenOf(0).isAppKey(new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', ctrlKey: true }))).toBe(true)
    expect(store.getState().terminalTabs).toHaveLength(2)
  })

  it('closes the tab showing on Close (⌘W) with the focus in the terminal, leaving the window open', async () => {
    const { store } = await renderTerminal()
    const [first] = screenElements()
    if (first === undefined) throw new Error('No screen')
    first.tabIndex = -1
    first.focus()

    let closed = false
    await act(() => {
      closed = requestClose()
      return Promise.resolve()
    })

    expect(closed).toBe(true)
    expect(store.getState().terminalTabs.map(({ id }) => id)).toEqual(['b'])
  })

  it('leaves Close to the window with the focus elsewhere', async () => {
    const { store } = await renderTerminal()

    expect(requestClose()).toBe(false)
    expect(store.getState().terminalTabs).toHaveLength(2)
  })

  it('leaves other keys to the shell and the app', async () => {
    const { store } = await renderTerminal()
    const [first] = screenElements()
    if (first === undefined) throw new Error('No screen')

    const typed = fireEvent.keyDown(first, { code: 'KeyC', key: 'c', ctrlKey: true })
    const newTab = fireEvent.keyDown(first, { code: 'KeyT', key: 't', metaKey: true })
    const focus = fireEvent.keyDown(first, { code: 'Backquote', key: '`', ctrlKey: true })

    expect([typed, newTab, focus]).toEqual([true, true, true])
    expect(store.getState().terminalTabs).toHaveLength(2)
  })

  // #412: a screen opened before its font had loaded measured the fallback's shorter cell, and its rows later outgrew
  // the card.
  it('opens no screen, and starts no shell, until the terminal’s font has loaded', async () => {
    let loaded: () => void = () => undefined
    terminalFont.loading = new Promise((resolve) => {
      loaded = resolve
    })
    const { calls } = await renderTerminal()

    expect(screen.queryAllByTestId('terminal-screen')).toEqual([])
    expect(screens).toEqual([])
    expect(calls).toEqual([])

    await act(async () => {
      loaded()
      await Promise.resolve()
    })

    expect(screenElements().map((element) => element.dataset.active)).toEqual(['true', 'false'])
    expect(screenOf(0).shown).toBe('$ echo hi\r\nhi\r\n$ ')
    expect(calls).toEqual(['attach a 80x24', 'attach b 80x24'])
  })

  it('opens no screen once it’s gone, if the font loads after', async () => {
    let loaded: () => void = () => undefined
    terminalFont.loading = new Promise((resolve) => {
      loaded = resolve
    })
    const { calls } = await renderTerminal()

    cleanup()
    await act(async () => {
      loaded()
      await Promise.resolve()
    })

    expect(screens).toEqual([])
    expect(calls).toEqual([])
  })

  it('lets go of its screens when their tabs close', async () => {
    const { store } = await renderTerminal()
    const first = screenOf(0)

    await act(() => store.getState().closeTerminal('a'))

    expect(first.disposed).toBe(true)
    expect(screenOf(1).disposed).toBe(false)
  })

  it('shows nothing it loads for a tab that closed before its output loaded', async () => {
    let answer: (response: TerminalAttachResponse) => void = () => undefined
    const { store } = await renderTerminal(
      { terminalTabs: [tab('a')] },
      {
        [CommandName.TerminalAttach]: () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      },
    )

    await act(() => store.getState().closeTerminal('a'))
    await act(async () => {
      answer({ output: 'late', end: 4 })
      await Promise.resolve()
    })

    expect(screenOf(0).shown).toBe('')
  })
})

describe('Terminal, across workspaces', () => {
  const workspaces = [sampleWorkspace('w1', 'Acme API'), sampleWorkspace('w2', 'Acme Web')]

  it('keeps every workspace’s screens, showing the workspace’s tab, and what a hidden one output when you come back', async () => {
    const { store, fake, calls } = await renderTerminal({
      workspaces,
      terminalTabs: [tab('a'), tab('x', { workspaceId: 'w2' })],
      terminalOutput: { a: 'acme-api $ ', x: 'acme-web $ ' },
    })
    expect(screenElements().map((element) => element.dataset.active)).toEqual(['true', 'false'])

    await act(() => store.getState().selectTerminal('a'))
    expect(screenOf(0).focuses).toBe(1)
    fake.emit({ type: EventType.TerminalOutput, tabId: 'x', offset: 11, data: 'npm run dev\r\nready\r\n' })
    const fits = screenOf(1).fits
    await act(() => store.getState().openWorkspace('w2'))

    // The tab now showing fits the card, but switching workspace doesn't take the focus.
    expect(screenOf(1).fits).toBe(fits + 1)
    expect(screens.map(({ focuses }) => focuses)).toEqual([1, 0])

    expect(screenElements().map((element) => element.dataset.active)).toEqual(['false', 'true'])
    expect(screenOf(1).shown).toBe('acme-web $ npm run dev\r\nready\r\n')
    expect(screens.map(({ disposed }) => disposed)).toEqual([false, false])
    // Switching loads nothing again and starts no shell: each screen stayed in the page.
    expect(calls).toEqual(['attach a 80x24', 'attach x 80x24'])
    expect(screen.queryByText('No terminal open. Start one with + or ⌘T.')).toBeNull()

    await act(() => store.getState().openWorkspace('w1'))
    expect(screenElements().map((element) => element.dataset.active)).toEqual(['true', 'false'])
    expect(screenOf(0).shown).toBe('acme-api $ ')
  })

  it('says how to start a terminal in a workspace with none, over the other workspaces’ hidden screens', async () => {
    const { store, calls } = await renderTerminal({
      workspaces,
      terminalTabs: [tab('x', { workspaceId: 'w2' })],
    })

    expect(screen.getByText('No terminal open. Start one with + or ⌘T.')).toBeInTheDocument()
    expect(screenElements().map((element) => element.dataset.active)).toEqual(['false'])

    // With no tab of its own showing, the terminal's keys and Close do nothing to the other workspace's.
    const [hidden] = screenElements()
    if (hidden === undefined) throw new Error('No screen')
    expect(fireEvent.keyDown(hidden, { code: 'KeyK', key: 'k', metaKey: true })).toBe(true)
    hidden.tabIndex = -1
    hidden.focus()
    expect(requestClose()).toBe(false)
    expect(calls).toEqual(['attach x 80x24'])
    expect(store.getState().terminalTabs).toHaveLength(1)
  })
})
