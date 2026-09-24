import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { Panel, PANELS } from '../panels'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge } from '../store/test-bridge'
import { usePanelShortcuts } from './usePanelShortcuts'

function Harness({ panels }: { readonly panels: readonly Panel[] }): React.JSX.Element {
  usePanelShortcuts(panels)
  return <textarea aria-label="Message" />
}

async function renderShortcuts(panels: readonly Panel[] = PANELS, uiState: UiStateEntry[] = []) {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const view = render(
    <GladeStoreProvider store={store}>
      <Harness panels={panels} />
    </GladeStoreProvider>,
  )
  const collapsed = () => ({
    sidebar: store.getState().uiState[UiStateKey.SidebarCollapsed],
    rightPanel: store.getState().uiState[UiStateKey.RightPanelCollapsed],
    bottomBar: store.getState().uiState[UiStateKey.BottomBarCollapsed],
  })
  return { ...fake, view, collapsed }
}

describe('usePanelShortcuts', () => {
  it('toggles the task list with ⌘B, the right panel with ⌘⌥B and the bottom bar with ⌘J, even while typing', async () => {
    const { collapsed } = await renderShortcuts()
    const textbox = screen.getByRole('textbox', { name: 'Message' })

    expect(fireEvent.keyDown(textbox, { code: 'KeyB', key: 'b', metaKey: true })).toBe(false)
    expect(collapsed()).toEqual({ sidebar: 'true', rightPanel: undefined, bottomBar: undefined })
    // ⌥ changes the character (⌥B types ∫), so ⌘⌥B goes by the physical key.
    fireEvent.keyDown(window, { code: 'KeyB', key: '∫', metaKey: true, altKey: true })
    expect(collapsed()).toEqual({ sidebar: 'true', rightPanel: 'true', bottomBar: undefined })
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', metaKey: true })
    expect(collapsed()).toEqual({ sidebar: 'true', rightPanel: 'true', bottomBar: 'true' })

    // Again, each opens.
    fireEvent.keyDown(window, { code: 'KeyB', key: 'B', metaKey: true })
    fireEvent.keyDown(window, { code: 'KeyB', key: '∫', metaKey: true, altKey: true })
    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', metaKey: true })
    expect(collapsed()).toEqual({ sidebar: 'false', rightPanel: 'false', bottomBar: 'false' })
  })

  it('opens a panel that starts collapsed', async () => {
    const { collapsed } = await renderShortcuts(PANELS, [{ key: UiStateKey.BottomBarCollapsed, value: 'true' }])

    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', metaKey: true })

    expect(collapsed().bottomBar).toBe('false')
  })

  it('leaves alone the panels the window doesn’t show', async () => {
    const { invoke } = await renderShortcuts([Panel.BottomBar])
    invoke.mockClear()

    expect(fireEvent.keyDown(window, { code: 'KeyB', key: 'b', metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { code: 'KeyB', key: '∫', metaKey: true, altKey: true })).toBe(true)

    expect(invoke).not.toHaveBeenCalled()
  })

  it('ignores other keys and other modifiers', async () => {
    const { invoke } = await renderShortcuts()
    invoke.mockClear()

    for (const init of [
      { code: 'KeyB', key: 'b' },
      { code: 'KeyB', key: 'b', ctrlKey: true },
      { code: 'KeyB', key: 'B', metaKey: true, shiftKey: true },
      { code: 'KeyB', key: 'b', metaKey: true, ctrlKey: true },
      { code: 'KeyJ', key: '∆', metaKey: true, altKey: true },
      { code: 'KeyK', key: 'k', metaKey: true },
      { code: 'KeyN', key: 'n', metaKey: true },
    ]) {
      expect(fireEvent.keyDown(window, init)).toBe(true)
    }

    expect(invoke).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', async () => {
    const { view, collapsed } = await renderShortcuts()
    view.unmount()

    fireEvent.keyDown(window, { code: 'KeyJ', key: 'j', metaKey: true })

    expect(collapsed().bottomBar).toBeUndefined()
  })
})
