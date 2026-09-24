import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { moduleClass } from '../moduleClass'
import { Divider } from './Divider'
import styles from './Divider.module.css'

const cls = (name: string): string => moduleClass(styles, name)

it('renders a separator', () => {
  render(<Divider className="extra" />)

  expect(screen.getByRole('separator')).toHaveClass(cls('divider'), 'extra')
})
