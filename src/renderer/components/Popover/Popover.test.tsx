import { fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { moduleClass } from '../moduleClass'
import { Placement } from '../Placement'
import { settleFloating } from '../settleFloating'
import { Popover } from './Popover'
import styles from './Popover.module.css'

const cls = (name: string): string => moduleClass(styles, name)

interface HarnessProps {
  placement?: Placement
  children?: ReactNode
}

/** A button that toggles a popover beside it. */
function Harness({
  placement,
  children = <button type="button">Compact now</button>,
}: HarnessProps): React.JSX.Element {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        ref={setTrigger}
        onClick={() => {
          setOpen(!open)
        }}
      >
        Context used
      </button>
      <button type="button">Elsewhere</button>
      <Popover
        label="Context"
        anchor={trigger}
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        placement={placement}
        className="extra"
      >
        {children}
      </Popover>
    </>
  )
}

async function openPopover(props: HarnessProps = {}): Promise<HTMLElement> {
  render(<Harness {...props} />)
  const trigger = screen.getByRole('button', { name: 'Context used' })
  trigger.focus()
  fireEvent.click(trigger)
  await settleFloating()
  return trigger
}

describe('Popover', () => {
  it('renders nothing while closed', () => {
    render(<Harness />)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens as a labelled dialog and focuses its first control', async () => {
    await openPopover()
    const dialog = screen.getByRole('dialog', { name: 'Context' })

    expect(dialog).toHaveClass(cls('popover'), 'extra')
    expect(dialog.style.position).toBe('absolute')
    expect(screen.getByRole('button', { name: 'Compact now' })).toHaveFocus()
  })

  it('focuses itself when it has no controls', async () => {
    await openPopover({ children: 'Compacts automatically at 99%.', placement: Placement.BottomStart })

    expect(screen.getByRole('dialog', { name: 'Context' })).toHaveFocus()
  })

  it('closes on Esc and returns focus to the trigger', async () => {
    const trigger = await openPopover()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Compact now' }), { key: 'Escape' })
    await settleFloating()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('closes on a click outside', async () => {
    await openPopover()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }))
    await settleFloating()

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays open on a click inside', async () => {
    await openPopover()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Compact now' }))
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Compact now' }))
    await settleFloating()

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('toggles closed from its trigger', async () => {
    const trigger = await openPopover()
    fireEvent.pointerDown(trigger)
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    await settleFloating()

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
