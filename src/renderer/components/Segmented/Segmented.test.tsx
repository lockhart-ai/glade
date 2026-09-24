import { faBell } from '@fortawesome/free-regular-svg-icons'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { moduleClass } from '../moduleClass'
import { Segmented, type SegmentedOption } from './Segmented'
import styles from './Segmented.module.css'

const cls = (name: string): string => moduleClass(styles, name)

enum Effort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

const OPTIONS: SegmentedOption<Effort>[] = [
  { value: Effort.Low, label: 'Low' },
  { value: Effort.Medium, label: 'Medium' },
  { value: Effort.High, label: 'High' },
]

function renderEffort(value: Effort | '', onChange = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <Segmented<Effort | ''> label="Effort" options={OPTIONS} value={value} onChange={onChange} className="extra" />,
  )
  return onChange
}

describe('Segmented', () => {
  it('renders a radio group with the chosen option checked and holding the tab stop', () => {
    renderEffort(Effort.Medium)

    expect(screen.getByRole('radiogroup', { name: 'Effort' })).toHaveClass(cls('group'), 'extra')
    expect(screen.getByRole('radiogroup')).not.toHaveAttribute('aria-disabled')
    const radios = screen.getAllByRole('radio')
    expect(radios.map((radio) => radio.textContent)).toEqual(['Low', 'Medium', 'High'])
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked()
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1])
    expect(screen.getByRole('radio', { name: 'Low' })).toHaveAttribute('type', 'button')
  })

  it('gives the first option the tab stop when nothing is chosen', () => {
    renderEffort('')

    expect(screen.getAllByRole('radio').map((radio) => radio.tabIndex)).toEqual([0, -1, -1])
    expect(screen.queryByRole('radio', { checked: true })).toBeNull()
  })

  it('chooses an option on click', () => {
    const onChange = renderEffort(Effort.Low)
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))

    expect(onChange).toHaveBeenCalledExactlyOnceWith(Effort.High)
  })

  it.each([
    ['ArrowRight', Effort.Medium, Effort.High],
    ['ArrowDown', Effort.Medium, Effort.High],
    ['ArrowLeft', Effort.Medium, Effort.Low],
    ['ArrowUp', Effort.Medium, Effort.Low],
    ['ArrowRight', Effort.High, Effort.Low],
    ['ArrowLeft', Effort.Low, Effort.High],
  ])('%s from %s chooses and focuses %s', (key, from, to) => {
    const onChange = renderEffort(from)
    const current = screen.getByRole('radio', { checked: true })
    current.focus()
    fireEvent.keyDown(current, { key })

    expect(onChange).toHaveBeenCalledExactlyOnceWith(to)
    expect(screen.getByRole('radio', { name: OPTIONS.find((option) => option.value === to)?.label })).toHaveFocus()
  })

  it('ignores other keys', () => {
    const onChange = renderEffort(Effort.Low)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Low' }), { key: 'a' })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('can be disabled', () => {
    const onChange = vi.fn()
    render(<Segmented label="Effort" options={OPTIONS} value={Effort.Low} onChange={onChange} disabled />)
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))

    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-disabled', 'true')
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("shows an option's icon before its label", () => {
    render(
      <Segmented
        label="Notify"
        options={[
          { value: 'bell', label: 'Bell', icon: faBell },
          { value: 'none', label: 'None' },
        ]}
        value="bell"
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('radio', { name: 'Bell' }).firstElementChild).toHaveAttribute('data-icon', 'bell')
    expect(screen.getByRole('radio', { name: 'None' }).querySelector('svg')).toBeNull()
  })
})
