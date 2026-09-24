import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType, type TerminalAttachResponse } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { refuse, sampleTerminalTab, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { Terminal } from './Terminal'
import { screens, type FakeScreen } from './test-screen'

vi.mock('./screen', () => import('./test-screen'))

/** The ResizeObserver callbacks the screens registered, to fire as a resized card would. */
let observed: (() => void)[] = []

beforeEach(() => {
  screens.length = 0
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

async function renderTerminal(
  main: Partial<FakeMain> = {},
  overrides: Partial<FakeHandlers> = {},
): Promise<StoreWrapper & { calls: string[] }> {
  const calls: string[] = []
  const wrapper = storeWrapper(
    {
      terminalTabs: [sampleTerminalTab('a'), sampleTerminalTab('b')],
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
      { terminalTabs: [sampleTerminalTab('a')] },
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
      { terminalTabs: [sampleTerminalTab('a')] },
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

  it('goes round the tabs with ⌃⇥ and ⌃⇧⇥, clears with ⌘K and closes with ⌘W, from the terminal', async () => {
    const { store, calls } = await renderTerminal()
    const [first] = screenElements()
    if (first === undefined) throw new Error('No screen')

    fireEvent.keyDown(first, { code: 'Tab', key: 'Tab', ctrlKey: true })
    await act(() => Promise.resolve())
    expect(store.getState().uiState[UiStateKey.TerminalTab]).toBe('b')
    fireEvent.keyDown(first, { code: 'Tab', key: 'Tab', ctrlKey: true, shiftKey: true })
    await act(() => Promise.resolve())
    expect(store.getState().uiState[UiStateKey.TerminalTab]).toBe('a')

    fireEvent.keyDown(first, { code: 'KeyK', key: 'k', metaKey: true })
    await act(() => Promise.resolve())
    expect(calls).toContain('clear a')

    fireEvent.keyDown(first, { code: 'KeyW', key: 'w', metaKey: true })
    await act(() => Promise.resolve())
    expect(store.getState().terminalTabs.map(({ id }) => id)).toEqual(['b'])
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
      { terminalTabs: [sampleTerminalTab('a')] },
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
