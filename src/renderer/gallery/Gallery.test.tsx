import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Gallery } from './Gallery'

it('shows a section for every component', () => {
  render(<Gallery />)

  for (const name of [
    'Button',
    'Pill · Dot · Kbd · Icon',
    'Card · Divider',
    'Input · Textarea',
    'Toggle',
    'Segmented',
  ]) {
    expect(screen.getByRole('region', { name })).toBeInTheDocument()
  }
})

it('shows each task state as a pill and a dot', () => {
  render(<Gallery />)
  const status = screen.getByRole('region', { name: 'Pill · Dot · Kbd · Icon' })

  for (const state of ['working', 'waiting', 'done', 'error']) {
    expect(within(status).getByRole('img', { name: state })).toBeInTheDocument()
  }
  expect(within(status).getByText('Active · waiting on you')).toBeInTheDocument()
})

it('pins and unpins the sample icon button', () => {
  render(<Gallery />)
  fireEvent.click(screen.getByRole('button', { name: 'Pin task' }))

  expect(screen.getByRole('button', { name: 'Unpin task' })).toHaveAttribute('aria-pressed', 'true')
})

it('keeps the live samples interactive', () => {
  render(<Gallery />)

  fireEvent.change(screen.getByRole('searchbox', { name: 'Search tasks' }), { target: { value: 'rate' } })
  expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('rate')

  fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Use 60' } })
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveValue('Use 60')

  fireEvent.click(screen.getByRole('switch', { name: 'Task titles' }))
  expect(screen.getByRole('switch', { name: 'Task titles' })).toBeChecked()

  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Effort' })).getByRole('radio', { name: 'Max' }))
  expect(within(screen.getByRole('radiogroup', { name: 'Effort' })).getByRole('radio', { name: 'Max' })).toBeChecked()
})
