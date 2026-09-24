import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { App } from './App'

it('renders the placeholder', () => {
  render(<App />)

  expect(screen.getByRole('main')).toHaveTextContent('Glade')
})
