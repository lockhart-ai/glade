import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandId } from '../../shared/keymap'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge } from '../store/test-bridge'
import { useCommands, type CommandHandlers } from './hooks'
import { commandRegistry, isTextField } from './registry'

function Harness({ handlers }: { readonly handlers: CommandHandlers }): React.JSX.Element {
  useCommands(handlers)
  return <textarea aria-label="Message" />
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

const TOGGLE_TASK_LIST = { key: 'b', code: 'KeyB', metaKey: true }

describe('the command registry', () => {
  it('runs a command on its binding as it now is, once you rebind it', async () => {
    const store = await setup()
    const toggle = vi.fn()
    renderWith(store, { [CommandId.ToggleTaskList]: toggle })

    expect(fireEvent.keyDown(window, TOGGLE_TASK_LIST)).toBe(false)
    expect(toggle).toHaveBeenCalledOnce()

    await act(() => store.getState().updateSettings({ keyBindings: { [CommandId.ToggleTaskList]: 'Ctrl+Alt+T' } }))

    // The old keys are nobody's now, so they're left alone.
    expect(fireEvent.keyDown(window, TOGGLE_TASK_LIST)).toBe(true)
    expect(fireEvent.keyDown(window, { key: '†', code: 'KeyT', ctrlKey: true, altKey: true })).toBe(false)
    expect(toggle).toHaveBeenCalledTimes(2)
  })

  it('gives a digit range’s handler the digit pressed', async () => {
    const store = await setup()
    const switchTo = vi.fn()
    renderWith(store, { [CommandId.SwitchWorkspace]: switchTo })

    fireEvent.keyDown(window, { key: '4', code: 'Digit4', metaKey: true })

    expect(switchTo).toHaveBeenCalledWith({ digit: 4 })
  })

  it('leaves a shortcut kept out of text fields to the field', async () => {
    const store = await setup()
    const next = vi.fn()
    renderWith(store, { [CommandId.NextTask]: next })

    expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown', altKey: true })).toBe(true)
    expect(next).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true })
    expect(next).toHaveBeenCalledOnce()
  })

  it('runs the handler registered last, and the earlier one again once that one goes', async () => {
    const store = await setup()
    const first = vi.fn()
    const second = vi.fn()
    renderWith(store, { [CommandId.NewTask]: first })
    const later = renderWith(store, { [CommandId.NewTask]: second })

    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()

    later.unmount()
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    expect(first).toHaveBeenCalledOnce()
  })

  it('registers only the commands with a handler, and runs the latest handler', async () => {
    const store = await setup()
    const first = vi.fn()
    const second = vi.fn()
    const view = renderWith(store, { [CommandId.NewTask]: first, [CommandId.MarkDone]: null })

    expect(commandRegistry(store).has(CommandId.NewTask)).toBe(true)
    expect(commandRegistry(store).has(CommandId.MarkDone)).toBe(false)
    expect(fireEvent.keyDown(window, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true })).toBe(true)

    view.rerender(
      <GladeStoreProvider store={store}>
        <Harness handlers={{ [CommandId.NewTask]: second }} />
      </GladeStoreProvider>,
    )
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })

  it('runs a command without its keys, as a menu would, and says when nothing can', async () => {
    const store = await setup()
    const settings = vi.fn()
    const view = renderWith(store, { [CommandId.OpenSettings]: settings })
    const registry = commandRegistry(store)

    expect(registry.run(CommandId.OpenSettings)).toBe(true)
    expect(settings).toHaveBeenCalledWith({ digit: null })
    expect(registry.run(CommandId.MarkDone)).toBe(false)

    view.unmount()
    expect(registry.run(CommandId.OpenSettings)).toBe(false)
    // With nothing registered, the window isn't listened to at all.
    expect(fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })).toBe(true)
  })

  it('ignores modifiers pressed alone', async () => {
    const store = await setup()
    const toggle = vi.fn()
    renderWith(store, { [CommandId.ToggleTaskList]: toggle })

    expect(fireEvent.keyDown(window, { key: 'Meta', code: 'MetaLeft', metaKey: true })).toBe(true)
    expect(toggle).not.toHaveBeenCalled()
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
