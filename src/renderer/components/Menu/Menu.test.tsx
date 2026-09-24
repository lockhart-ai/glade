import { faThumbtack } from '@fortawesome/free-solid-svg-icons'
import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { moduleClass } from '../moduleClass'
import { Placement } from '../Placement'
import { settleFloating } from '../settleFloating'
import { Menu, MenuAnchorKind, MenuEntryKind, MenuItemVariant, type MenuAnchor, type MenuEntry } from './Menu'
import styles from './Menu.module.css'

const cls = (name: string): string => moduleClass(styles, name)

interface Actions {
  open: Mock<() => void>
  pin: Mock<() => void>
  rename: Mock<() => void>
  remove: Mock<() => void>
}

function makeEntries(actions: Actions): MenuEntry[] {
  return [
    { kind: MenuEntryKind.Item, label: 'Open', shortcut: '↵', onSelect: actions.open },
    { kind: MenuEntryKind.Separator },
    { kind: MenuEntryKind.Item, label: 'Pin to top', icon: faThumbtack, shortcut: '⌘⇧P', onSelect: actions.pin },
    { kind: MenuEntryKind.Item, label: 'Rename…', onSelect: actions.rename },
    { kind: MenuEntryKind.Separator },
    { kind: MenuEntryKind.Item, label: 'Delete task…', variant: MenuItemVariant.Destructive, onSelect: actions.remove },
  ]
}

function makeActions(): Actions {
  return { open: vi.fn(), pin: vi.fn(), rename: vi.fn(), remove: vi.fn() }
}

interface HarnessProps {
  actions: Actions
  placement?: Placement
}

/** A dropdown button and a right-click target, each opening the same menu. */
function Harness({ actions, placement }: HarnessProps): React.JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)

  return (
    <>
      <button
        type="button"
        ref={trigger}
        onClick={() => {
          setAnchor({ kind: MenuAnchorKind.Element, element: trigger.current, placement })
        }}
      >
        Actions
      </button>
      <div
        onContextMenu={(event) => {
          event.preventDefault()
          setAnchor({ kind: MenuAnchorKind.Point, x: event.clientX, y: event.clientY })
        }}
      >
        Task row
      </div>
      <button type="button">Elsewhere</button>
      <Menu
        label="Task actions"
        entries={makeEntries(actions)}
        anchor={anchor ?? { kind: MenuAnchorKind.Point, x: 0, y: 0 }}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
        className="extra"
      />
    </>
  )
}

async function openFromButton(actions = makeActions(), placement?: Placement): Promise<Actions> {
  render(<Harness actions={actions} placement={placement} />)
  const trigger = screen.getByRole('button', { name: 'Actions' })
  trigger.focus()
  fireEvent.click(trigger)
  await settleFloating()
  return actions
}

function menu(): HTMLElement {
  return screen.getByRole('menu', { name: 'Task actions' })
}

function key(name: string): void {
  const target = document.activeElement ?? document.body
  fireEvent.keyDown(target, { key: name })
}

describe('Menu', () => {
  it('renders nothing while closed', () => {
    render(<Harness actions={makeActions()} />)

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('renders items, separators, icons, shortcut hints and destructive items in a portal', async () => {
    await openFromButton()

    expect(menu()).toHaveClass(cls('menu'), 'extra')
    expect(menu().parentElement?.parentElement).not.toBe(document.querySelector('#root'))
    const items = screen.getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Open↵', 'Pin to top⌘⇧P', 'Rename…', 'Delete task…'])
    expect(screen.getAllByRole('separator')).toHaveLength(2)
    expect(screen.getByRole('menuitem', { name: /Pin to top/ }).querySelector('svg')).toHaveAttribute(
      'data-icon',
      'thumbtack',
    )
    expect(screen.getByText('⌘⇧P').tagName).toBe('KBD')
    expect(screen.getByRole('menuitem', { name: 'Delete task…' })).toHaveClass(cls('item'), cls('destructive'))
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).not.toHaveClass(cls('destructive'))
  })

  it('labels groups of items with headings, which the arrow keys skip', async () => {
    const choose = vi.fn()
    render(
      <Menu
        label="Files"
        entries={[
          { kind: MenuEntryKind.Heading, label: 'Changed' },
          { kind: MenuEntryKind.Item, label: 'docs/rate-limits.md', onSelect: choose },
          { kind: MenuEntryKind.Heading, label: 'Read' },
          { kind: MenuEntryKind.Item, label: 'api/views.py', onSelect: choose },
        ]}
        anchor={{ kind: MenuAnchorKind.Point, x: 0, y: 0 }}
        open
        onClose={() => undefined}
      />,
    )
    await settleFloating()

    expect(screen.getByRole('menu', { name: 'Files' })).toHaveTextContent('Changeddocs/rate-limits.mdReadapi/views.py')
    expect(screen.getByText('Changed')).toHaveClass(cls('heading'))
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    key('ArrowDown')
    key('ArrowDown')
    expect(screen.getByRole('menuitem', { name: 'api/views.py' })).toHaveFocus()
  })

  it('takes focus when it opens', async () => {
    await openFromButton()

    expect(menu()).toHaveFocus()
  })

  it('moves with the arrow keys and wraps at both ends', async () => {
    await openFromButton()

    key('ArrowDown')
    expect(screen.getByRole('menuitem', { name: /Open/ })).toHaveFocus()
    key('ArrowDown')
    expect(screen.getByRole('menuitem', { name: /Pin to top/ })).toHaveFocus()
    key('ArrowUp')
    key('ArrowUp')
    expect(screen.getByRole('menuitem', { name: 'Delete task…' })).toHaveFocus()
    key('ArrowDown')
    expect(screen.getByRole('menuitem', { name: /Open/ })).toHaveFocus()
  })

  it('chooses the focused item with Enter, closes, and returns focus to the trigger', async () => {
    const actions = await openFromButton()

    key('ArrowDown')
    key('ArrowDown')
    key('Enter')
    await settleFloating()

    expect(actions.pin).toHaveBeenCalledOnce()
    expect(actions.open).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus()
  })

  it('ignores other keys on an item', async () => {
    const actions = await openFromButton()

    key('ArrowDown')
    key('Shift')

    expect(actions.open).not.toHaveBeenCalled()
    expect(menu()).toBeInTheDocument()
  })

  it('chooses an item on click', async () => {
    const actions = await openFromButton()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete task…' }))
    await settleFloating()

    expect(actions.remove).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('jumps to an item by typing its label', async () => {
    await openFromButton()

    key('r')
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toHaveFocus()
  })

  it('closes on Esc without choosing, and returns focus to the trigger', async () => {
    const actions = await openFromButton()

    key('ArrowDown')
    key('Escape')
    await settleFloating()

    expect(screen.queryByRole('menu')).toBeNull()
    expect(actions.open).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus()
  })

  it('closes on a click outside', async () => {
    await openFromButton()

    // While the menu is open, the rest of the page is hidden from assistive tech, so find it by its text.
    fireEvent.pointerDown(screen.getByText('Elsewhere'))
    fireEvent.mouseDown(screen.getByText('Elsewhere'))
    await settleFloating()

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens at the pointer on a right-click', async () => {
    const actions = makeActions()
    render(<Harness actions={actions} />)
    fireEvent.contextMenu(screen.getByText('Task row'), { clientX: 120, clientY: 80 })
    await settleFloating()

    expect(menu()).toHaveFocus()
    expect(menu().style.position).toBe('absolute')
    key('ArrowUp')
    key('Enter')
    expect(actions.remove).toHaveBeenCalledOnce()
  })

  it('moves from the pointer to its button when opened from each in turn', async () => {
    render(<Harness actions={makeActions()} />)
    fireEvent.contextMenu(screen.getByText('Task row'), { clientX: 120, clientY: 80 })
    await settleFloating()
    // jsdom's viewport has no height, so only the x position survives the edge padding.
    expect(menu().style.transform).toMatch(/^translate\(120px, /)

    key('Escape')
    await settleFloating()
    fireEvent.click(screen.getByText('Actions'))
    await settleFloating()
    // jsdom lays the button out at 0,0: the menu sits 4px below it, kept 8px from the window's edge.
    expect(menu().style.transform).toBe('translate(8px, 4px)')
  })

  it('takes a placement beside its anchor', async () => {
    await openFromButton(makeActions(), Placement.TopEnd)

    expect(menu()).toBeInTheDocument()
  })

  it('marks a picker’s options as choices, with a check on the chosen one', async () => {
    const choose = vi.fn()
    render(
      <Menu
        label="Effort"
        open
        onClose={() => undefined}
        anchor={{ kind: MenuAnchorKind.Point, x: 0, y: 0 }}
        entries={[
          { kind: MenuEntryKind.Item, label: 'Low', checked: false, onSelect: choose },
          { kind: MenuEntryKind.Item, label: 'High', checked: true, onSelect: choose },
        ]}
      />,
    )
    await settleFloating()

    const low = screen.getByRole('menuitemradio', { name: 'Low' })
    const high = screen.getByRole('menuitemradio', { name: 'High' })
    expect(low).toHaveAttribute('aria-checked', 'false')
    expect(high).toHaveAttribute('aria-checked', 'true')
    expect(low.querySelector(`.${cls('check')}`)).toBeNull()
    expect(high.querySelector(`.${cls('check')}`)).not.toBeNull()
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
