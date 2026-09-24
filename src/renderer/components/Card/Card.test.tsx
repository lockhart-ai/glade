import { moduleClass } from '../moduleClass'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card, CardLevel } from './Card'
import styles from './Card.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Card', () => {
  it('renders a top-level card by default', () => {
    render(<Card>Content</Card>)

    expect(screen.getByText('Content')).toHaveClass(cls('card'), cls('top-level'))
  })

  it('renders a nested card', () => {
    render(<Card level={CardLevel.Nested}>Content</Card>)

    expect(screen.getByText('Content')).toHaveClass(cls('card'), cls('nested'))
    expect(screen.getByText('Content')).not.toHaveClass(cls('top-level'))
  })

  it('forwards native props and merges the class name', () => {
    render(
      <Card role="region" aria-label="Task" className="extra">
        Content
      </Card>,
    )

    expect(screen.getByRole('region', { name: 'Task' })).toHaveClass('extra', cls('card'))
  })
})
