import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge } from '../store/test-bridge'
import { Panel } from './panels'
import { PanelToggle } from './PanelToggle'

async function renderToggle(panel: Panel, uiState: UiStateEntry[] = []) {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <PanelToggle panel={panel} className="extra" />
    </GladeStoreProvider>,
  )
  return { ...fake, store }
}

describe('PanelToggle', () => {
  it('collapses an open panel, then shows it again, storing each change', async () => {
    const { store, invoke } = await renderToggle(Panel.Sidebar)

    const collapse = screen.getByRole('button', { name: 'Collapse task list' })
    expect(collapse).toHaveAttribute('title', 'Collapse task list (⌘B)')
    expect(collapse).toHaveClass('extra')
    fireEvent.click(collapse)

    expect(store.getState().uiState[UiStateKey.SidebarCollapsed]).toBe('true')
    expect(invoke).toHaveBeenCalledWith(CommandName.UiStateSet, { key: UiStateKey.SidebarCollapsed, value: 'true' })
    const show = screen.getByRole('button', { name: 'Show task list' })
    expect(show).toHaveAttribute('title', 'Show task list (⌘B)')
    fireEvent.click(show)
    expect(store.getState().uiState[UiStateKey.SidebarCollapsed]).toBe('false')
  })

  it('starts from the stored state', async () => {
    await renderToggle(Panel.BottomBar, [{ key: UiStateKey.BottomBarCollapsed, value: 'true' }])

    expect(screen.getByRole('button', { name: 'Show bottom panel' })).toHaveAttribute('title', 'Show bottom panel (⌘J)')
  })
})
