import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TaskIndicator } from '../../../shared/taskIndicator'
import { moduleClass } from '../moduleClass'
import { Dot } from './Dot'
import styles from './Dot.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Dot', () => {
  it.each(Object.values(TaskIndicator))('renders the %s colour', (state) => {
    const { container } = render(<Dot state={state} />)
    const dot = container.firstElementChild

    expect(dot).toHaveClass(cls('dot'), cls(state))
    expect(dot).toHaveAttribute('data-state', state)
  })

  it('is decorative without a label', () => {
    const { container } = render(<Dot state={TaskIndicator.Done} className="extra" />)

    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(container.firstElementChild).toHaveClass('extra')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('is an image named by its label', () => {
    render(<Dot state={TaskIndicator.Waiting} label="Waiting on you" />)

    expect(screen.getByRole('img', { name: 'Waiting on you' })).not.toHaveAttribute('aria-hidden')
  })
})
