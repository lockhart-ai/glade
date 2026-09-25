import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOTION_DURATION_PROPERTY } from '../../motion'
import { moduleClass } from '../moduleClass'
import { Collapse } from './Collapse'
import styles from './Collapse.module.css'

const cls = (name: string): string => moduleClass(styles, name)

/** The Collapse's own element, around the content. */
function wrapper(): HTMLElement | null {
  return screen.queryByText('Rows')?.parentElement ?? null
}

describe('Collapse', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.documentElement.style.setProperty(MOTION_DURATION_PROPERTY, '200ms')
  })

  afterEach(() => {
    document.documentElement.style.removeProperty(MOTION_DURATION_PROPERTY)
    vi.useRealTimers()
  })

  it('shows what is open from the start at once, and nothing while closed', () => {
    const { rerender } = render(<Collapse open={true}>Rows</Collapse>)
    expect(wrapper()).toHaveClass(cls('collapse'))
    expect(wrapper()).not.toHaveClass(cls('entering'))

    rerender(<Collapse open={false}>Rows</Collapse>)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByText('Rows')).toBeNull()
    expect(render(<Collapse open={false}>Other</Collapse>).container).toBeEmptyDOMElement()
  })

  it('opens by growing, then is still', () => {
    const { rerender } = render(
      <Collapse open={false} className="extra">
        Rows
      </Collapse>,
    )
    rerender(
      <Collapse open={true} className="extra">
        Rows
      </Collapse>,
    )
    expect(wrapper()).toHaveClass(cls('collapse'), cls('entering'), 'extra')
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(wrapper()).not.toHaveClass(cls('entering'))
  })

  it('closes by shrinking, inert on its way out, then goes', () => {
    const { rerender } = render(<Collapse open={true}>Rows</Collapse>)
    rerender(<Collapse open={false}>Rows</Collapse>)
    expect(wrapper()).toHaveClass(cls('leaving'))
    expect(wrapper()).toHaveAttribute('inert')
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByText('Rows')).toBeNull()
  })

  it('opens and closes at once with Reduce motion on', () => {
    document.documentElement.style.setProperty(MOTION_DURATION_PROPERTY, '0ms')
    const { rerender } = render(<Collapse open={true}>Rows</Collapse>)
    rerender(<Collapse open={false}>Rows</Collapse>)
    expect(screen.queryByText('Rows')).toBeNull()
    rerender(<Collapse open={true}>Rows</Collapse>)
    expect(wrapper()).not.toHaveClass(cls('entering'))
  })
})
