import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace } from '../store/test-bridge'
import { useRightPanelShortcuts } from './useRightPanelShortcuts'

function Harness(): React.JSX.Element {
  useRightPanelShortcuts()
  return <textarea aria-label="Message" />
}

async function renderShortcuts(uiState: UiStateEntry[] = []) {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
      ...uiState,
    ],
  })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const view = render(
    <GladeStoreProvider store={store}>
      <Harness />
    </GladeStoreProvider>,
  )
  const panel = () => ({
    tab: store.getState().uiState[UiStateKey.RightPanelTab],
    collapsed: store.getState().uiState[UiStateKey.RightPanelCollapsed],
  })
  return { ...fake, store, view, panel }
}

/** ⌘⌥ and a key, by its physical key: ⌥ changes the character a Mac key types (⌥2 types ™). */
function press(code: string, key: string, target: Element | Window = window): boolean {
  return fireEvent.keyDown(target, { code, key, metaKey: true, altKey: true })
}

describe('useRightPanelShortcuts', () => {
  it('picks a tab with ⌘⌥1–5, even while typing in a text field', async () => {
    const { panel } = await renderShortcuts()

    expect(press('Digit2', '™', screen.getByRole('textbox', { name: 'Message' }))).toBe(false)
    expect(panel().tab).toBe('files')
    press('Digit5', 'º')
    expect(panel().tab).toBe('subagents')
    press('Digit1', '¡')
    expect(panel().tab).toBe('tool-calls')
    press('Digit3', '£')
    expect(panel().tab).toBe('todos')
    press('Digit4', '¢')
    expect(panel().tab).toBe('artifacts')
    expect(panel().collapsed).toBeUndefined()
  })

  it('opens a collapsed panel at the tab ⌘⌥ and a digit picks', async () => {
    const { panel } = await renderShortcuts([{ key: UiStateKey.RightPanelCollapsed, value: 'true' }])

    press('Digit3', '£')

    expect(panel()).toEqual({ tab: 'todos', collapsed: 'false' })
  })

  it('ignores other keys and other modifiers', async () => {
    const { invoke } = await renderShortcuts()
    invoke.mockClear()

    for (const init of [
      { code: 'Digit8', key: '•', metaKey: true, altKey: true },
      { code: 'Digit0', key: 'º', metaKey: true, altKey: true },
      { code: 'KeyN', key: '˜', metaKey: true, altKey: true },
      { code: 'ArrowDown', key: 'ArrowDown', metaKey: true, altKey: true },
      { code: 'Digit2', key: '2', metaKey: true },
      { code: 'Digit2', key: '™', altKey: true },
      { code: 'KeyB', key: '∫', metaKey: true, altKey: true },
      { code: 'Digit2', key: '™', metaKey: true, altKey: true, shiftKey: true },
      { code: 'Digit2', key: '™', metaKey: true, altKey: true, ctrlKey: true },
    ]) {
      expect(fireEvent.keyDown(window, init)).toBe(true)
    }

    expect(invoke).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', async () => {
    const { panel, view } = await renderShortcuts()
    view.unmount()

    press('Digit2', '™')

    expect(panel().tab).toBeUndefined()
  })
})
