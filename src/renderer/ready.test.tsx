import { render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { READY_ATTRIBUTE } from '../shared/ready'
import { ReadySignal } from './ready'

afterEach(() => {
  document.documentElement.removeAttribute(READY_ATTRIBUTE)
})

function isReady(): boolean {
  return document.documentElement.hasAttribute(READY_ATTRIBUTE)
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

it('marks the page ready once it has rendered and the fonts have loaded', async () => {
  render(
    <ReadySignal>
      <p>Page</p>
    </ReadySignal>,
  )

  expect(screen.getByText('Page')).toBeInTheDocument()
  await settle()
  expect(isReady()).toBe(true)
})

it('waits for what the page says it needs', async () => {
  let finish = (): void => undefined
  const until = new Promise<void>((resolve) => {
    finish = resolve
  })
  render(
    <ReadySignal until={until}>
      <p>Page</p>
    </ReadySignal>,
  )

  await settle()
  expect(isReady()).toBe(false)
  finish()
  await settle()
  expect(isReady()).toBe(true)
})

it('still marks the page ready when what it waits for fails', async () => {
  render(
    <ReadySignal until={Promise.reject(new Error('no'))}>
      <p>Page</p>
    </ReadySignal>,
  )

  await settle()
  expect(isReady()).toBe(true)
})
