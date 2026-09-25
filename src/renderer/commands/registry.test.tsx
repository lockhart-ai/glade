import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppCommandId, WorkspaceCommandId, WindowCommandId } from '../../shared/commands'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge } from '../store/test-bridge'
import { useCommands, type CommandHandlers } from './hooks'
import { commandRegistry, isMessageField, isTextField, MESSAGE_FIELD_PROPS } from './registry'

function Harness({ handlers }: { readonly handlers: CommandHandlers }): React.JSX.Element {
  useCommands(handlers)
  return (
    <>
      <textarea aria-label="Note" />
      <textarea aria-label="Message" {...MESSAGE_FIELD_PROPS} />
    </>
  )
}

async function setup(): Promise<GladeStore> {
  const store = createGladeStore(fakeBridge({ workspaces: [], tasks: [], uiState: [] }).bridge)
  await act(() => store.getState().hydrate())
  return store
}

function renderWith(store: GladeStore, handlers: CommandHandlers) {
  return render(
    <GladeStoreProvider store={store}>
      <Harness handlers={handlers} />
    </GladeStoreProvider>,
  )
}

const SEARCH_TASKS = { key: 'f', code: 'KeyF', metaKey: true }
const STOP = { key: '.', code: 'Period', metaKey: true }

describe('the command registry', () => {
  it('runs a command on its binding as it now is, once you rebind it', async () => {
    const store = await setup()
    const search = vi.fn()
    renderWith(store, { [WindowCommandId.SearchTasks]: search })

    expect(fireEvent.keyDown(window, SEARCH_TASKS)).toBe(false)
    expect(search).toHaveBeenCalledOnce()

    await act(() => store.getState().updateSettings({ keyBindings: { [WindowCommandId.SearchTasks]: 'Ctrl+Alt+T' } }))

    // The old keys are nobody's now, so they're left alone.
    expect(fireEvent.keyDown(window, SEARCH_TASKS)).toBe(true)
    expect(fireEvent.keyDown(window, { key: '†', code: 'KeyT', ctrlKey: true, altKey: true })).toBe(false)
    expect(search).toHaveBeenCalledTimes(2)
  })

  it('gives a digit range’s handler the digit pressed', async () => {
    const store = await setup()
    const showTab = vi.fn()
    renderWith(store, { [WindowCommandId.ShowPanelTab]: showTab })

    fireEvent.keyDown(window, { key: '¢', code: 'Digit4', metaKey: true, altKey: true })

    expect(showTab).toHaveBeenCalledWith({ digit: 4 })
  })

  it('leaves the menu bar’s keys to the menu bar, which answers them itself', async () => {
    const store = await setup()
    const newTask = vi.fn()
    renderWith(store, { [AppCommandId.NewTask]: newTask, [WorkspaceCommandId.Switch]: newTask })

    expect(fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: '2', code: 'Digit2', metaKey: true })).toBe(true)
    expect(newTask).not.toHaveBeenCalled()
  })

  it('leaves ⌥↑ / ⌥↓ to a text field, but not to the message field', async () => {
    const store = await setup()
    const next = vi.fn()
    const previous = vi.fn()
    renderWith(store, { [WindowCommandId.NextTask]: next, [WindowCommandId.PreviousTask]: previous })

    // Another text field moves its caret.
    expect(fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), { key: 'ArrowDown', altKey: true })).toBe(
      true,
    )
    expect(next).not.toHaveBeenCalled()
    // The message field switches tasks, as the window does outside text fields.
    const message = screen.getByRole('textbox', { name: 'Message' })
    expect(fireEvent.keyDown(message, { key: 'ArrowDown', altKey: true })).toBe(false)
    expect(fireEvent.keyDown(message, { key: 'ArrowUp', altKey: true })).toBe(false)
    expect(fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })).toBe(false)
    expect(next).toHaveBeenCalledTimes(2)
    expect(previous).toHaveBeenCalledOnce()
  })

  it('switches tasks from the message field on the keys you rebound it to', async () => {
    const store = await setup()
    const next = vi.fn()
    renderWith(store, { [WindowCommandId.NextTask]: next })
    await act(() => store.getState().updateSettings({ keyBindings: { [WindowCommandId.NextTask]: 'Ctrl+Alt+J' } }))
    const message = screen.getByRole('textbox', { name: 'Message' })

    // The old keys are the field's again.
    expect(fireEvent.keyDown(message, { key: 'ArrowDown', altKey: true })).toBe(true)
    expect(fireEvent.keyDown(message, { key: '∆', code: 'KeyJ', ctrlKey: true, altKey: true })).toBe(false)
    expect(
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), {
        key: '∆',
        code: 'KeyJ',
        ctrlKey: true,
        altKey: true,
      }),
    ).toBe(true)
    expect(next).toHaveBeenCalledOnce()
  })

  it('runs the handler registered last, and the earlier one again once that one goes', async () => {
    const store = await setup()
    const first = vi.fn()
    const second = vi.fn()
    renderWith(store, { [WindowCommandId.StopAgent]: first })
    const later = renderWith(store, { [WindowCommandId.StopAgent]: second })

    fireEvent.keyDown(window, STOP)
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()

    later.unmount()
    fireEvent.keyDown(window, STOP)
    expect(first).toHaveBeenCalledOnce()
  })

  it('registers only the commands with a handler, and runs the latest handler', async () => {
    const store = await setup()
    const first = vi.fn()
    const second = vi.fn()
    const view = renderWith(store, { [WindowCommandId.StopAgent]: first, [WindowCommandId.CompactContext]: null })

    expect(commandRegistry(store).has(WindowCommandId.StopAgent)).toBe(true)
    expect(commandRegistry(store).has(WindowCommandId.CompactContext)).toBe(false)
    expect(fireEvent.keyDown(window, { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true })).toBe(true)

    view.rerender(
      <GladeStoreProvider store={store}>
        <Harness handlers={{ [WindowCommandId.StopAgent]: second }} />
      </GladeStoreProvider>,
    )
    fireEvent.keyDown(window, STOP)
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })

  it('runs a command without its keys, and says when nothing can', async () => {
    const store = await setup()
    const settings = vi.fn()
    const view = renderWith(store, { [WindowCommandId.FocusInput]: settings })
    const registry = commandRegistry(store)

    expect(registry.run(WindowCommandId.FocusInput)).toBe(true)
    expect(settings).toHaveBeenCalledWith({ digit: null })
    expect(registry.run(WindowCommandId.CompactContext)).toBe(false)

    view.unmount()
    expect(registry.run(WindowCommandId.FocusInput)).toBe(false)
    // With nothing registered, the window isn't listened to at all.
    expect(fireEvent.keyDown(window, { key: 'l', code: 'KeyL', metaKey: true })).toBe(true)
  })

  it('ignores modifiers pressed alone', async () => {
    const store = await setup()
    const toggle = vi.fn()
    renderWith(store, { [WindowCommandId.SearchTasks]: toggle })

    expect(fireEvent.keyDown(window, { key: 'Meta', code: 'MetaLeft', metaKey: true })).toBe(true)
    expect(toggle).not.toHaveBeenCalled()
  })
})

describe('isMessageField', () => {
  it('is the element marked as the message field, and nothing else', () => {
    const message = document.createElement('textarea')
    Object.assign(message.dataset, { keyScope: MESSAGE_FIELD_PROPS['data-key-scope'] })

    expect(isMessageField(message)).toBe(true)
    expect(isMessageField(document.createElement('textarea'))).toBe(false)
    expect(isMessageField(window)).toBe(false)
    expect(isMessageField(null)).toBe(false)
  })
})

describe('isTextField', () => {
  it('is an input, a textarea or something editable', () => {
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    // jsdom doesn't compute it.
    Object.defineProperty(editable, 'isContentEditable', { value: true })

    expect(isTextField(document.createElement('input'))).toBe(true)
    expect(isTextField(document.createElement('textarea'))).toBe(true)
    expect(isTextField(editable)).toBe(true)
    expect(isTextField(document.createElement('button'))).toBe(false)
    expect(isTextField(window)).toBe(false)
    expect(isTextField(null)).toBe(false)
  })
})
