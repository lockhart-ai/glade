import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { settleFloating } from '../components/settleFloating'
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
    'Tabs',
    'Menu',
    'Popover · Toast',
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

it('switches tabs', () => {
  render(<Gallery />)
  fireEvent.click(screen.getByRole('tab', { name: 'Todos 3/4' }))

  expect(screen.getByRole('tabpanel', { name: 'Todos 3/4' })).toHaveTextContent('The Todos panel.')
})

it('opens the sample menu from its button and from a right-click, and shows what was chosen', async () => {
  render(<Gallery />)
  fireEvent.click(screen.getByRole('button', { name: 'Task actions' }))
  await settleFloating()
  fireEvent.click(screen.getByRole('menuitem', { name: /Pin to top/ }))
  await settleFloating()

  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByText('Pin to top')).toBeInTheDocument()

  fireEvent.contextMenu(screen.getByText('Right-click here'), { clientX: 40, clientY: 40 })
  await settleFloating()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete task…' }))
  await settleFloating()

  expect(screen.getByText('Delete task…')).toBeInTheDocument()
})

it('opens and closes the sample popover', async () => {
  render(<Gallery />)
  fireEvent.click(screen.getByRole('button', { name: 'Context 97%' }))
  await settleFloating()

  expect(screen.getByRole('dialog', { name: 'Context' })).toHaveTextContent('97% · 194k / 200k')
  fireEvent.keyDown(screen.getByRole('button', { name: 'Compact now' }), { key: 'Escape' })
  await settleFloating()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows sample toasts, and undoes from one', () => {
  render(<Gallery />)
  const notifications = screen.getByRole('region', { name: 'Notifications' })

  fireEvent.click(screen.getByRole('button', { name: 'Plain toast' }))
  expect(within(notifications).getByText('Copied link to task.')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Show toast' }))
  fireEvent.click(within(notifications).getByRole('button', { name: 'Undo' }))
  expect(within(notifications).queryByText(/Marked done/)).toBeNull()
  expect(within(notifications).getByText('Reopened.')).toBeInTheDocument()
})
