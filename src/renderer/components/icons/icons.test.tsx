import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CheckIcon, ChevronDownIcon, PinIcon, PlusIcon, SearchIcon } from './icons'

describe.each([
  ['CheckIcon', CheckIcon, '16'],
  ['PlusIcon', PlusIcon, '16'],
  ['ChevronDownIcon', ChevronDownIcon, '12'],
  ['PinIcon', PinIcon, '15'],
  ['SearchIcon', SearchIcon, '15'],
])('%s', (_name, Icon, defaultSize) => {
  it('draws a decorative stroke icon at its default size', () => {
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('stroke', 'currentColor')
    expect(svg).toHaveAttribute('fill', 'none')
    expect(svg).toHaveAttribute('width', defaultSize)
  })

  it('takes a size, stroke width and class', () => {
    const { container } = render(<Icon size={20} strokeWidth={1.5} className="custom" />)
    const svg = container.querySelector('svg')

    expect(svg).toHaveAttribute('width', '20')
    expect(svg).toHaveAttribute('height', '20')
    expect(svg).toHaveAttribute('stroke-width', '1.5')
    expect(svg).toHaveClass('custom')
  })
})
