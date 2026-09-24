import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TaskIndicator } from '../../../shared/taskIndicator'
import dotStyles from '../Dot/Dot.module.css'
import { moduleClass } from '../moduleClass'
import { Pill } from './Pill'
import styles from './Pill.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Pill', () => {
  it.each(Object.values(TaskIndicator))('renders the %s tint with a matching dot', (indicator) => {
    render(<Pill indicator={indicator}>Active</Pill>)
    const pill = screen.getByText('Active')

    expect(pill).toHaveClass(cls('pill'), cls(indicator))
    expect(pill.querySelector(`.${moduleClass(dotStyles, 'dot')}`)).toHaveAttribute('data-state', indicator)
  })

  it('forwards native props and merges the class name', () => {
    render(
      <Pill indicator={TaskIndicator.Working} className="extra" title="Status">
        Active · working
      </Pill>,
    )

    expect(screen.getByTitle('Status')).toHaveClass('extra', cls('pill'))
    expect(screen.getByTitle('Status')).toHaveTextContent('Active · working')
  })
})
