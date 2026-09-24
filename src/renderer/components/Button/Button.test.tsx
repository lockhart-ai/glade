import { moduleClass } from '../moduleClass'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PinIcon } from '../icons/icons'
import { Button, ButtonSize, ButtonVariant } from './Button'
import styles from './Button.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Button', () => {
  it('renders a dark, medium button of type "button" by default', () => {
    render(<Button>Open task</Button>)
    const button = screen.getByRole('button', { name: 'Open task' })

    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass(cls('button'), cls('dark'), cls('medium'))
  })

  it.each(Object.values(ButtonVariant).filter((variant) => variant !== ButtonVariant.Icon))(
    'renders the %s variant',
    (variant) => {
      render(<Button variant={variant}>Go</Button>)

      expect(screen.getByRole('button')).toHaveClass(cls(variant))
    },
  )

  it.each(Object.values(ButtonSize))('renders the %s size', (size) => {
    render(<Button size={size}>Go</Button>)

    expect(screen.getByRole('button')).toHaveClass(cls(size))
  })

  it('renders an icon button without a size, named by its aria-label', () => {
    render(
      <Button variant={ButtonVariant.Icon} aria-label="Pin task" aria-pressed={false}>
        <PinIcon />
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Pin task' })

    expect(button).toHaveClass(cls('icon'))
    expect(button).not.toHaveClass(cls('medium'))
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('forwards native props and merges the class name', () => {
    const onClick = vi.fn()
    render(
      <Button type="submit" className="extra" title="Save it" onClick={onClick}>
        Save
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(button)

    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toHaveAttribute('title', 'Save it')
    expect(button).toHaveClass('extra', cls('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not fire clicks when disabled', () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    )
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByRole('button')).toBeDisabled()
    expect(onClick).not.toHaveBeenCalled()
  })
})
