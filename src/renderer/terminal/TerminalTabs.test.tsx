import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { refuse, sampleTerminalTab, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { TerminalTabs } from './TerminalTabs'

async function renderTabs(
  main: Partial<FakeMain> = {},
  overrides: Partial<FakeHandlers> = {},
): Promise<StoreWrapper & { calls: string[] }> {
  const calls: string[] = []
  const wrapper = storeWrapper(
    {
      terminalTabs: [
        sampleTerminalTab('a', { process: 'python3', running: true }),
        sampleTerminalTab('b', { name: 'server', cwd: '/code/web' }),
      ],
      terminalCalls: calls,
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.TerminalTab, value: 'b' },
      ],
      ...main,
    },
    overrides,
  )
  await act(() => wrapper.store.getState().hydrate())
  render(<TerminalTabs />, { wrapper: wrapper.wrapper })
  return { ...wrapper, calls }
}

function tabRow(): HTMLElement {
  return screen.getByRole('group', { name: 'Terminal tabs' })
}

function tabButtons(): HTMLElement[] {
  return within(tabRow())
    .queryAllByRole('button')
    .filter((button) => button.hasAttribute('aria-pressed'))
}

async function openMenu(index: number): Promise<string[]> {
  const tab = tabButtons()[index]?.parentElement ?? document.body
  fireEvent.contextMenu(tab)
  await act(() => Promise.resolve())
  return screen.getAllByRole('menuitem').map((item) => item.textContent)
}

async function choose(index: number, label: string): Promise<void> {
  await openMenu(index)
  fireEvent.click(screen.getAllByRole('menuitem').find((item) => item.textContent.startsWith(label)) ?? document.body)
  await act(() => Promise.resolve())
}

describe('TerminalTabs', () => {
  it('shows a tab per shell, with a dot while a program runs, and the folder of the tab showing', async () => {
    await renderTabs()

    expect(tabButtons().map((button) => button.textContent)).toEqual(['python3', 'server'])
    expect(tabButtons().map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(within(tabButtons()[0] ?? document.body).getByRole('img', { name: 'Running' })).toBeInTheDocument()
    expect(within(tabButtons()[1] ?? document.body).queryByRole('img')).toBeNull()
    expect(tabButtons()[0]?.parentElement).toHaveAttribute('title', '~/code/api')
    expect(screen.getByText('/code/web')).toBeInTheDocument()
  })

  it('shows no folder while there is no tab', async () => {
    await renderTabs({ terminalTabs: [] })

    expect(tabButtons()).toEqual([])
    expect(screen.queryByText(/^\//)).toBeNull()
  })

  it('shows a tab you click, closes one with its ×, and opens a new one with +', async () => {
    const { store } = await renderTabs()

    fireEvent.click(tabButtons()[0] ?? document.body)
    await act(() => Promise.resolve())
    expect(store.getState().uiState[UiStateKey.TerminalTab]).toBe('a')

    fireEvent.click(screen.getByRole('button', { name: 'Close server' }))
    await act(() => Promise.resolve())
    expect(tabButtons().map((button) => button.textContent)).toEqual(['python3'])

    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    await act(() => Promise.resolve())
    expect(tabButtons().map((button) => button.textContent)).toEqual(['python3', 'zsh'])
    expect(store.getState().uiState[UiStateKey.TerminalTab]).toBe('term-1')
  })

  it('has a context menu to rename, duplicate, clear, interrupt and close a tab', async () => {
    const { store, calls } = await renderTabs()

    expect(await openMenu(0)).toEqual(['Rename…', 'Duplicate', 'Clear⌘K', 'Kill process⌃C', 'Close⌘W'])
    fireEvent.click(screen.getByRole('menuitem', { name: /^Clear/ }))
    await act(() => Promise.resolve())
    await choose(0, 'Kill process')
    await choose(0, 'Duplicate')
    expect(tabButtons().map((button) => button.textContent)).toEqual(['python3', 'zsh', 'server'])
    await choose(1, 'Close')

    expect(calls).toEqual(['clear a', 'interrupt a'])
    expect(store.getState().terminalTabs.map(({ id }) => id)).toEqual(['a', 'b'])
  })

  it('renames a tab in place: ↵ saves, a blank name is refused, and Esc cancels', async () => {
    await renderTabs()

    await choose(1, 'Rename…')
    const field = screen.getByRole('textbox', { name: 'Terminal name' })
    expect(field).toHaveValue('server')
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: ' ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(() => Promise.resolve())
    expect(field).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(field, { target: { value: 'api' } })
    expect(field).toHaveAttribute('aria-invalid', 'false')
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(() => Promise.resolve())
    expect(tabButtons().map((button) => button.textContent)).toEqual(['python3', 'api'])

    await choose(0, 'Rename…')
    const again = screen.getByRole('textbox', { name: 'Terminal name' })
    fireEvent.change(again, { target: { value: 'never' } })
    fireEvent.keyDown(again, { key: 'Escape' })
    fireEvent.blur(again)
    expect(tabButtons().map((button) => button.textContent)).toEqual(['python3', 'api'])
  })

  it('saves a name when you leave the field, unless it’s blank', async () => {
    await renderTabs()

    await choose(0, 'Rename…')
    const field = screen.getByRole('textbox', { name: 'Terminal name' })
    fireEvent.change(field, { target: { value: 'worker' } })
    fireEvent.keyDown(field, { key: 'a' })
    fireEvent.blur(field)
    await act(() => Promise.resolve())
    expect(tabButtons().map((button) => button.textContent)).toEqual(['worker', 'server'])

    await choose(1, 'Rename…')
    const blank = screen.getByRole('textbox', { name: 'Terminal name' })
    fireEvent.change(blank, { target: { value: '' } })
    fireEvent.blur(blank)
    expect(tabButtons().map((button) => button.textContent)).toEqual(['worker', 'server'])
  })

  it('shows a toast when a tab can’t be renamed', async () => {
    await renderTabs(
      {},
      { [CommandName.TerminalRename]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No terminal tab b')) },
    )

    await choose(1, 'Rename…')
    const field = screen.getByRole('textbox', { name: 'Terminal name' })
    fireEvent.change(field, { target: { value: 'api' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(await screen.findByText('No terminal tab b')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Terminal name' })).toBeNull()
  })
})
