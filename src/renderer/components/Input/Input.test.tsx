import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { moduleClass } from '../moduleClass'
import { Input } from './Input'
import styles from './Input.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Input', () => {
  it('renders a text field named by its label', () => {
    render(<Input label="Workspace name" placeholder="Name" />)
    const input = screen.getByRole('textbox', { name: 'Workspace name' })

    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('placeholder', 'Name')
    expect(input).toHaveClass(cls('input'))
    expect(input.parentElement).toHaveClass(cls('field'))
    expect(input.parentElement?.querySelector('svg')).toBeNull()
  })

  it('shows an icon and puts the class name on the field', () => {
    const { container } = render(
      <Input label="Search tasks" type="search" icon={faMagnifyingGlass} className="extra" />,
    )

    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass(cls('field'), 'extra')
    expect(container.querySelector('svg')).toHaveAttribute('data-icon', 'magnifying-glass')
  })

  it('forwards native props and reports changes', () => {
    const onChange = vi.fn()
    render(<Input label="Name" value="Acme" onChange={onChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme API' } })

    expect(onChange).toHaveBeenCalledOnce()
  })

  it('can be disabled', () => {
    render(<Input label="Name" disabled />)

    expect(screen.getByRole('textbox')).toBeDisabled()
  })
})
