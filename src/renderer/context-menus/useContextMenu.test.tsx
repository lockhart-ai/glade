import { act, fireEvent, render as renderUnwrapped, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WindowCommandId } from '../../shared/commands'
import { resolveKeymap } from '../../shared/keymap'
import { MenuEntryKind, type MenuEntry } from '../components'
import { storeWrapper } from '../store/test-wrapper'
import { ContextMenu, isContextMenuKey, useContextMenu } from './useContextMenu'

/** Renders under a store, where the keymap comes from. */
function render(ui: React.ReactElement) {
  return renderUnwrapped(ui, { wrapper: storeWrapper().wrapper })
}

const NO_MODIFIERS = { code: '', shiftKey: false, metaKey: false, altKey: false, ctrlKey: false }

describe('isContextMenuKey', () => {
  it.each([
    [{ ...NO_MODIFIERS, key: 'F10', shiftKey: true }, true],
    [{ ...NO_MODIFIERS, key: 'ContextMenu' }, true],
    [{ ...NO_MODIFIERS, key: 'ContextMenu', shiftKey: true }, true],
    [{ ...NO_MODIFIERS, key: 'F10' }, false],
    [{ ...NO_MODIFIERS, key: 'F10', shiftKey: true, metaKey: true }, false],
    [{ ...NO_MODIFIERS, key: 'ContextMenu', ctrlKey: true }, false],
    [{ ...NO_MODIFIERS, key: 'ContextMenu', altKey: true }, false],
    [{ ...NO_MODIFIERS, key: 'Enter' }, false],
  ])('%o opens a context menu: %s', (event, opens) => {
    expect(isContextMenuKey(event)).toBe(opens)
  })

  it('takes Context menu’s keys once you rebind it, and the context-menu key still', () => {
    const keymap = resolveKeymap({ [WindowCommandId.ContextMenu]: 'Ctrl+M' })

    expect(isContextMenuKey({ ...NO_MODIFIERS, key: 'm', code: 'KeyM', ctrlKey: true }, keymap)).toBe(true)
    expect(isContextMenuKey({ ...NO_MODIFIERS, key: 'F10', shiftKey: true }, keymap)).toBe(false)
    expect(isContextMenuKey({ ...NO_MODIFIERS, key: 'ContextMenu' }, keymap)).toBe(true)
  })
})

interface ListProps {
  readonly onChoose: (row: string) => void
}

/** Two rows sharing one menu; the second holds a nested target, and a row with no items opens nothing. */
function List({ onChoose }: ListProps): React.JSX.Element {
  const menu = useContextMenu<string>()
  const entries = (row: string): MenuEntry[] =>
    row === 'empty'
      ? []
      : [
          {
            kind: MenuEntryKind.Item,
            label: `Choose ${row}`,
            onSelect: () => {
              onChoose(row)
            },
          },
        ]
  return (
    <>
      <button type="button" {...menu.targetProps('first')}>
        First
      </button>
      <div {...menu.targetProps('second')}>
        Second <button type="button">Inside second</button>
        <span {...menu.targetProps('nested')}>Nested</span>
      </div>
      <span {...menu.targetProps('empty')}>Empty</span>
      <button
        type="button"
        onClick={(event) => {
          menu.openBelow('second', event.currentTarget)
        }}
      >
        More
      </button>
      <ContextMenu label="Row actions" state={menu} entries={entries} />
    </>
  )
}

describe('useContextMenu', () => {
  it('opens the menu for the row right-clicked, at the pointer, and runs the item chosen', async () => {
    const onChoose = vi.fn()
    render(<List onChoose={onChoose} />)

    const event = fireEvent.contextMenu(screen.getByRole('button', { name: 'First' }), { clientX: 40, clientY: 60 })
    expect(event).toBe(false)
    await act(() => Promise.resolve())
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Choose first' }))

    expect(onChoose).toHaveBeenCalledExactlyOnceWith('first')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens the innermost target’s menu', async () => {
    render(<List onChoose={vi.fn()} />)

    fireEvent.contextMenu(screen.getByText('Nested'))
    await act(() => Promise.resolve())

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Choose nested'])
  })

  it('opens the focused row’s menu on ⇧F10 or the context-menu key, from anything inside it', async () => {
    render(<List onChoose={vi.fn()} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'First' }), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Choose first'])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Inside second' }), { key: 'ContextMenu' })
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Choose second'])
  })

  it('leaves any other key alone', () => {
    render(<List onChoose={vi.fn()} />)

    const event = fireEvent.keyDown(screen.getByRole('button', { name: 'First' }), { key: 'F10' })

    expect(event).toBe(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens a row’s menu from a button, below it', async () => {
    const onChoose = vi.fn()
    render(<List onChoose={onChoose} />)

    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    await act(() => Promise.resolve())

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Choose second'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Choose second' }))
    expect(onChoose).toHaveBeenCalledExactlyOnceWith('second')
  })

  it('opens nothing for a target with no items', () => {
    render(<List onChoose={vi.fn()} />)

    fireEvent.contextMenu(screen.getByText('Empty'))

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
