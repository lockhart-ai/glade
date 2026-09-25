import { act, fireEvent, render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { refuse, sampleTerminalTab } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import { useTerminalShortcuts } from './useTerminalShortcuts'

function Shortcuts(): null {
  useTerminalShortcuts()
  return null
}

it('focuses the terminal with ⌃`, and opens a new tab with ⌘T, wherever the focus is', async () => {
  const { store, wrapper } = storeWrapper({
    terminalTabs: [sampleTerminalTab('a')],
    uiState: [{ key: UiStateKey.BottomBarCollapsed, value: 'true' }],
  })
  await act(() => store.getState().hydrate())
  render(<Shortcuts />, { wrapper })

  const focus = fireEvent.keyDown(window, { code: 'Backquote', key: '`', ctrlKey: true })
  await act(() => Promise.resolve())
  expect(focus).toBe(false)
  expect(store.getState().terminalFocusRequest).toBe(1)
  expect(store.getState().uiState[UiStateKey.BottomBarCollapsed]).toBe('false')

  const newTab = fireEvent.keyDown(window, { code: 'KeyT', key: 't', metaKey: true })
  await act(() => Promise.resolve())
  expect(newTab).toBe(false)
  expect(store.getState().terminalTabs.map(({ id }) => id)).toEqual(['a', 'term-1'])

  // The tab-by-tab shortcuts work in the terminal only.
  expect(fireEvent.keyDown(window, { code: 'KeyK', key: 'k', metaKey: true })).toBe(true)
  expect(fireEvent.keyDown(window, { code: 'KeyT', key: 't' })).toBe(true)
})

it('shows a toast when a new tab can’t be opened', async () => {
  const { store, wrapper } = storeWrapper(
    {},
    { [CommandName.TerminalCreate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No workspace w1')) },
  )
  await act(() => store.getState().hydrate())
  const { findByText } = render(<Shortcuts />, { wrapper })

  fireEvent.keyDown(window, { code: 'KeyT', key: 't', metaKey: true })

  expect(await findByText('No workspace w1')).toBeInTheDocument()
})
