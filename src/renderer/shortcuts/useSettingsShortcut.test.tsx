import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge } from '../store/test-bridge'
import { SettingsSection } from '../settings/sections'
import { useSettingsShortcut } from './useSettingsShortcut'

function Harness(): React.JSX.Element {
  useSettingsShortcut()
  return <textarea aria-label="Message the agent" />
}

async function renderShortcut(): Promise<{ store: GladeStore; unmount: () => void }> {
  const store = createGladeStore(fakeBridge({ workspaces: [], tasks: [], uiState: [] }).bridge)
  await act(() => store.getState().hydrate())
  const { unmount } = render(
    <GladeStoreProvider store={store}>
      <Harness />
    </GladeStoreProvider>,
  )
  return { store, unmount }
}

/** Presses ⌘, (or a variation of it) in the window; false when the app took the key. */
function pressCommandComma(init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(window, { key: ',', metaKey: true, ...init })
}

describe('⌘,', () => {
  it('opens Settings at the Agent section, from anywhere', async () => {
    const { store } = await renderShortcut()

    act(() => {
      expect(pressCommandComma()).toBe(false)
    })

    expect(store.getState().settingsSection).toBe(SettingsSection.Agent)
  })

  it('leaves Settings on the section it shows when it is already open', async () => {
    const { store } = await renderShortcut()
    act(() => {
      store.getState().openSettings(SettingsSection.Keyboard)
    })

    act(() => {
      pressCommandComma()
    })

    expect(store.getState().settingsSection).toBe(SettingsSection.Keyboard)
  })

  it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: false }])(
    'ignores the key with other modifiers: %o',
    async (init) => {
      const { store } = await renderShortcut()

      expect(pressCommandComma(init)).toBe(true)
      expect(store.getState().settingsSection).toBeNull()
    },
  )

  it('stops listening once unmounted', async () => {
    const { store, unmount } = await renderShortcut()
    unmount()

    pressCommandComma()

    expect(store.getState().settingsSection).toBeNull()
  })
})
