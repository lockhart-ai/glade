import { faBell } from '@fortawesome/free-regular-svg-icons'
import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { moduleClass } from '../moduleClass'
import { Icon, IconSize } from './Icon'
import styles from './Icon.module.css'

const cls = (name: string): string => moduleClass(styles, name)

describe('Icon', () => {
  it('renders a decorative medium SVG icon by default', () => {
    const { container } = render(<Icon icon={faCheck} />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('data-icon', 'check')
    expect(svg).toHaveClass(cls('icon'), cls('medium'))
  })

  it.each(Object.values(IconSize))('renders the %s size', (size) => {
    const { container } = render(<Icon icon={faBell} size={size} className="extra" />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveClass(cls(size), 'extra')
    expect(svg).toHaveAttribute('data-prefix', 'far')
  })
})
