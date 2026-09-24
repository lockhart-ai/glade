import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { moduleClass } from '../moduleClass'
import { Kbd } from './Kbd'
import styles from './Kbd.module.css'

const cls = (name: string): string => moduleClass(styles, name)

it('renders a keycap as a <kbd>', () => {
  render(
    <Kbd className="extra" title="New task">
      ⌘N
    </Kbd>,
  )
  const key = screen.getByText('⌘N')

  expect(key.tagName).toBe('KBD')
  expect(key).toHaveClass(cls('kbd'), 'extra')
  expect(key).toHaveAttribute('title', 'New task')
})
