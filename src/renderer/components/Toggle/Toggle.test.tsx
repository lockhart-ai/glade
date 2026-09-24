import { moduleClass } from '../moduleClass'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Toggle } from './Toggle'
import styles from './Toggle.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Toggle', () => {
  it('renders a switch named by its label', () => {
    render(<Toggle checked label="Status summary" onChange={vi.fn()} />)
    const toggle = screen.getByRole('switch', { name: 'Status summary' })

    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle).toHaveAttribute('type', 'button')
    expect(toggle).toBeChecked()
    expect(toggle).toHaveClass(cls('toggle'))
  })

  it.each([
    [true, false],
    [false, true],
  ])('when checked is %s, a click asks for %s', (checked, next) => {
    const onChange = vi.fn()
    render(<Toggle checked={checked} label="Task titles" onChange={onChange} />)
    const toggle = screen.getByRole('switch')

    expect(toggle).toHaveAttribute('aria-checked', String(checked))
    fireEvent.click(toggle)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(next)
  })

  it('forwards native props and does nothing when disabled', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} label="Task titles" onChange={onChange} disabled className="extra" />)
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)

    expect(toggle).toBeDisabled()
    expect(toggle).toHaveClass('extra', cls('toggle'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
