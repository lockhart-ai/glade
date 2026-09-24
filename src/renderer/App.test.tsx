import { render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { App } from './App'

it('renders the window layout with a placeholder in each region', () => {
  render(<App />)

  expect(screen.getByRole('navigation', { name: 'Tasks' })).toHaveTextContent('Sidebar')

  const main = screen.getByRole('main', { name: 'Task' })
  expect(within(main).getByRole('region', { name: 'Task header' })).toHaveTextContent('Task header')
  expect(within(main).getByRole('region', { name: 'Chat' })).toHaveTextContent('Chat')
  expect(within(main).getByTestId('input-bar')).toHaveTextContent('Input bar')

  const panel = within(main).getByRole('complementary', { name: 'Task panel' })
  expect(panel).toHaveTextContent('Tabs')
  expect(panel).toHaveTextContent('Right panel')

  const terminal = screen.getByRole('region', { name: 'Terminal' })
  expect(terminal).toHaveTextContent('Terminal tabs')
  expect(within(terminal).getByText('Terminal')).toBeInTheDocument()
})
