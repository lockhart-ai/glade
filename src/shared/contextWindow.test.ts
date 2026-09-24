import { expect, it } from 'vitest'
import { contextWindowFor, EXTENDED_CONTEXT_WINDOW, STANDARD_CONTEXT_WINDOW } from './contextWindow'

it('gives the 1M-context variants a 1M window', () => {
  expect(contextWindowFor('claude-opus-5-5[1m]')).toBe(EXTENDED_CONTEXT_WINDOW)
  expect(EXTENDED_CONTEXT_WINDOW).toBe(1_000_000)
})

it('gives every other model the standard 200k window', () => {
  expect(contextWindowFor('claude-sonnet-5')).toBe(STANDARD_CONTEXT_WINDOW)
  expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000)
})
