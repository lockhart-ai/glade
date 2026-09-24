import { act, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { mountApp } from './mount'

afterEach(() => {
  document.body.innerHTML = ''
})

it('renders the app into the root element', () => {
  const root = document.createElement('div')
  document.body.append(root)

  act(() => {
    mountApp(root)
  })

  expect(screen.getByRole('main')).toHaveTextContent('Glade')
})

it('renders another page when given one', () => {
  const root = document.createElement('div')
  document.body.append(root)

  act(() => {
    mountApp(root, <p>Gallery</p>)
  })

  expect(screen.getByText('Gallery')).toBeInTheDocument()
  expect(screen.queryByRole('main')).toBeNull()
})

it('throws when there is no root element', () => {
  expect(() => {
    mountApp(null)
  }).toThrow('Missing #root element')
})
