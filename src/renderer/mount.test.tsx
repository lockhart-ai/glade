import { act, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { mountApp } from './mount'

afterEach(() => {
  document.body.innerHTML = ''
})

it('renders the app into the root element', async () => {
  const root = document.createElement('div')
  document.body.append(root)

  await act(async () => {
    mountApp(root)
  })

  expect(screen.getByRole('main')).toHaveTextContent('Glade')
})

it('throws when there is no root element', () => {
  expect(() => mountApp(null)).toThrow('Missing #root element')
})
