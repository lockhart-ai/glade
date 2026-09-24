import { moduleClass } from '../moduleClass'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Textarea } from './Textarea'
import styles from './Textarea.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Textarea', () => {
  it('renders a two-row text area named by its label', () => {
    render(<Textarea label="Message the agent" placeholder="Reply…" />)
    const textarea = screen.getByRole('textbox', { name: 'Message the agent' })

    expect(textarea.tagName).toBe('TEXTAREA')
    expect(textarea).toHaveAttribute('rows', '2')
    expect(textarea).toHaveAttribute('placeholder', 'Reply…')
    expect(textarea).toHaveClass(cls('textarea'))
  })

  it('forwards native props, merges the class name and reports changes', () => {
    const onChange = vi.fn()
    render(<Textarea label="Objective" rows={4} className="extra" value="" onChange={onChange} disabled={false} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'Add rate limiting' } })

    expect(textarea).toHaveAttribute('rows', '4')
    expect(textarea).toHaveClass('extra', cls('textarea'))
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('can be disabled', () => {
    render(<Textarea label="Objective" disabled />)

    expect(screen.getByRole('textbox')).toBeDisabled()
  })
})
