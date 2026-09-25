import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { WindowCommandId, WorkspaceCommandId } from '../../shared/commands'
import { DEFAULT_KEYMAP, formatBinding, KEYMAP_LAYOUT, type KeyBindingOverrides } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { moduleClass } from '../components/moduleClass'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleWorkspace, type FakeBridge } from '../store/test-bridge'
import { RECORDING_PROMPT } from './KeyboardSection'
import { SettingsSection } from './sections'
import { SettingsDialog } from './SettingsDialog'
import styles from './SettingsDialog.module.css'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  /** Called when the window's dispatcher runs Search tasks (⌘F). */
  readonly toggled: ReturnType<typeof vi.fn>
}

function Dispatched({ onToggle }: { readonly onToggle: () => void }): null {
  useCommand(WindowCommandId.SearchTasks, onToggle)
  return null
}

async function renderKeyboard(keyBindings: KeyBindingOverrides = {}): Promise<Rendered> {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [],
    uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
  })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  if (Object.keys(keyBindings).length > 0) await act(() => store.getState().updateSettings({ keyBindings }))
  fake.invoke.mockClear()
  const toggled = vi.fn()
  render(
    <GladeStoreProvider store={store}>
      <Dispatched onToggle={toggled} />
      <SettingsDialog />
    </GladeStoreProvider>,
  )
  act(() => {
    store.getState().openSettings(SettingsSection.Keyboard)
  })
  await settleFloating()
  return { ...fake, store, toggled }
}

function keyBindingUpdates(invoke: FakeBridge['invoke']): unknown[] {
  return invoke.mock.calls
    .filter(([command]) => command === CommandName.SettingsUpdate)
    .map(([, request]) => (request as { patch: { keyBindings: unknown } }).patch.keyBindings)
}

function keycap(name: string | RegExp): HTMLElement {
  return screen.getByRole('button', { name })
}

/** Presses keys on what has the focus. */
function press(init: KeyboardEventInit): boolean {
  return fireEvent.keyDown(document.activeElement ?? document.body, init)
}

/** Clicks a keycap, which then waits for the keys; it has the focus, as a click gives it in a browser. */
function startRecording(name: string | RegExp): HTMLElement {
  const button = keycap(name)
  button.focus()
  fireEvent.click(button)
  return button
}

describe('KeyboardSection', () => {
  it('lists every shortcut, grouped as the keymap is, at its current keys', async () => {
    await renderKeyboard()

    for (const group of KEYMAP_LAYOUT) {
      const section = screen.getByRole('region', { name: group.area })
      for (const row of group.rows) expect(section).toHaveTextContent(row.action)
    }
    expect(keycap('Settings: ⌘,')).toHaveTextContent('⌘,')
    expect(keycap('Switch workspace: ⌘1 – ⌘9')).toBeInTheDocument()
    expect(keycap('Next task: ⌥↓')).toBeInTheDocument()
    expect(keycap('Previous task: ⌥↑')).toBeInTheDocument()
    expect(keycap('Tool calls · Files · Todos: ⌘⌥1–3')).toBeInTheDocument()
    expect(keycap('Artifacts · Subagents: ⌘⌥4–5')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reset/ })).not.toBeInTheDocument()
  })

  it('shows the fixed shortcuts as keys, not buttons, saying why', async () => {
    await renderKeyboard()

    const menus = screen.getByRole('region', { name: 'Menus and dialogs' })
    expect(within(menus).queryByRole('button')).not.toBeInTheDocument()
    expect(within(menus).getByText('↑↓')).toHaveAttribute('title', 'Fixed: the menus’ and dialogs’ own keys')
    expect(within(menus).getByText('1 – 9')).toBeInTheDocument()
    const panels = screen.getByRole('region', { name: 'Panels' })
    expect(within(panels).getByText('⌘W')).toHaveAttribute('title', 'Fixed: ⌘W closes the window everywhere else')
    expect(within(screen.getByRole('region', { name: 'Chat' })).getByText('⇧↵')).toHaveAttribute(
      'title',
      'Fixed: the text field’s own key',
    )
    expect(within(screen.getByRole('region', { name: 'Terminal' })).getByText('⌃C')).toHaveAttribute(
      'title',
      'Fixed: the terminal sends it to the shell',
    )
  })

  it('draws the fixed shortcuts muted, apart from the ones you can rebind', async () => {
    await renderKeyboard()

    const fixed = moduleClass(styles, 'fixedKey')
    expect(within(screen.getByRole('region', { name: 'Panels' })).getByText('⌘W')).toHaveClass(fixed)
    expect(within(screen.getByRole('region', { name: 'Menus and dialogs' })).getByText('↑↓')).toHaveClass(fixed)
    const rebindable = screen.getByRole('button', { name: 'New task: ⌘N' })
    expect(within(rebindable).getByText('⌘N')).not.toHaveClass(fixed)
  })

  it('records the keys you press as the new binding, saves it, and resets it to the default', async () => {
    const { invoke, store, toggled } = await renderKeyboard()

    const button = startRecording('Search tasks: ⌘F')
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveAccessibleName('Search tasks: press the new keys')
    expect(button).toHaveTextContent(RECORDING_PROMPT)
    // A modifier alone isn't a shortcut yet.
    expect(press({ key: 'Meta', metaKey: true })).toBe(false)
    expect(button).toHaveTextContent(RECORDING_PROMPT)
    expect(press({ key: 'L', code: 'KeyL', metaKey: true, shiftKey: true })).toBe(false)
    await act(() => Promise.resolve())

    expect(keyBindingUpdates(invoke)).toEqual([{ [WindowCommandId.SearchTasks]: 'Meta+Shift+L' }])
    expect(store.getState().settings.keyBindings).toEqual({ [WindowCommandId.SearchTasks]: 'Meta+Shift+L' })
    expect(keycap('Search tasks: ⌘⇧L')).toHaveAttribute('aria-pressed', 'false')
    expect(toggled).not.toHaveBeenCalled()

    fireEvent.click(keycap('Reset Search tasks to ⌘F'))
    await act(() => Promise.resolve())

    expect(keyBindingUpdates(invoke)).toEqual([{ [WindowCommandId.SearchTasks]: 'Meta+Shift+L' }, {}])
    expect(keycap('Search tasks: ⌘F')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reset/ })).not.toBeInTheDocument()
  })

  it('keeps the recorded keys from the window’s shortcuts, and a binding back at its default isn’t stored', async () => {
    const { invoke, toggled } = await renderKeyboard({ [WindowCommandId.SearchTasks]: 'Meta+Shift+L' })

    startRecording('Search tasks: ⌘⇧L')
    expect(press({ key: 'f', code: 'KeyF', metaKey: true })).toBe(false)
    await act(() => Promise.resolve())

    expect(toggled).not.toHaveBeenCalled()
    expect(keyBindingUpdates(invoke)).toEqual([{}])
    expect(keycap('Search tasks: ⌘F')).toBeInTheDocument()

    // Once it's recorded, ⌘F is the window's again.
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', metaKey: true })
    expect(toggled).toHaveBeenCalledOnce()
  })

  it('stops recording on Esc, without closing Settings, and on clicking away or clicking the keycap again', async () => {
    const { invoke } = await renderKeyboard()

    startRecording('New task: ⌘N')
    expect(press({ key: 'Escape' })).toBe(false)
    await settleFloating()
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    expect(keycap('New task: ⌘N')).toHaveAttribute('aria-pressed', 'false')

    const button = startRecording('New task: ⌘N')
    fireEvent.blur(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')

    startRecording('New task: ⌘N')
    fireEvent.click(keycap('New task: press the new keys'))
    expect(keycap('New task: ⌘N')).toHaveAttribute('aria-pressed', 'false')

    // Keys pressed on a keycap that isn't recording are left alone.
    keycap('New task: ⌘N').focus()
    expect(press({ key: 'x', code: 'KeyX', metaKey: true })).toBe(true)
    expect(keyBindingUpdates(invoke)).toEqual([])
  })

  it.each([
    [
      'another command’s keys',
      'New task: ⌘N',
      { key: 'b', code: 'KeyB', metaKey: true },
      '⌘B is already used by Toggle task list.',
    ],
    ['a reserved chord', 'New task: ⌘N', { key: 'q', code: 'KeyQ', metaKey: true }, '⌘Q is reserved for Quit Glade.'],
    [
      'a key that would type',
      'New task: ⌘N',
      { key: 'n', code: 'KeyN', shiftKey: true },
      '⇧N would type into text fields. Hold ⌘, ⌃ or ⌥ with it.',
    ],
    [
      'a range bound to a letter',
      'Switch workspace: ⌘1 – ⌘9',
      { key: 'a', code: 'KeyA', ctrlKey: true },
      'Press a number key with the modifiers to use for 1 – 9.',
    ],
  ])('refuses %s, saying why under the row', async (_, name, init, message) => {
    const { invoke } = await renderKeyboard()

    startRecording(name)
    press(init)
    await act(() => Promise.resolve())

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(keyBindingUpdates(invoke)).toEqual([])
    expect(keycap(name)).toHaveAttribute('aria-pressed', 'false')

    // Trying again clears it.
    fireEvent.click(keycap(name))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('rebinds a digit range by its modifiers, and both rows of the right panel’s tabs follow', async () => {
    const { store } = await renderKeyboard()

    startRecording('Switch workspace: ⌘1 – ⌘9')
    press({ key: '3', code: 'Digit3', ctrlKey: true })
    await act(() => Promise.resolve())
    startRecording('Artifacts · Subagents: ⌘⌥4–5')
    press({ key: '™', code: 'Digit2', ctrlKey: true, altKey: true })
    await act(() => Promise.resolve())

    expect(store.getState().settings.keyBindings).toEqual({
      [WorkspaceCommandId.Switch]: 'Ctrl+1',
      [WindowCommandId.ShowPanelTab]: 'Ctrl+Alt+1',
    })
    expect(keycap('Switch workspace: ⌃1 – ⌃9')).toBeInTheDocument()
    expect(keycap('Tool calls · Files · Todos: ⌃⌥1–3')).toBeInTheDocument()
    expect(keycap('Artifacts · Subagents: ⌃⌥4–5')).toBeInTheDocument()
    // One Reset on each row the range shows on.
    expect(screen.getAllByRole('button', { name: /^Reset Tool calls|^Reset Artifacts/ })).toHaveLength(2)
    expect(
      keycap(`Reset Switch workspace to ${formatBinding(WorkspaceCommandId.Switch, DEFAULT_KEYMAP)}`),
    ).toBeInTheDocument()
  })

  it('shows the problem only under the row it’s about', async () => {
    await renderKeyboard()

    startRecording('Next task: ⌥↓')
    press({ key: 'ArrowUp', altKey: true })
    await act(() => Promise.resolve())

    const row = screen.getByText('Next / previous task').closest('div')?.parentElement
    expect(row).toHaveTextContent('⌥↑ is already used by Previous task.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})
