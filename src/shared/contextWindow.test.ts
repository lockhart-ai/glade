import { expect, it } from 'vitest'
import {
  autoCompactThreshold,
  contextWindowFor,
  EXTENDED_CONTEXT_WINDOW,
  STANDARD_CONTEXT_WINDOW,
} from './contextWindow'

it('gives the 1M-context variants a 1M window', () => {
  expect(contextWindowFor('claude-opus-5-5[1m]')).toBe(EXTENDED_CONTEXT_WINDOW)
  expect(EXTENDED_CONTEXT_WINDOW).toBe(1_000_000)
})

it('gives every other model the standard 200k window', () => {
  expect(contextWindowFor('claude-sonnet-5')).toBe(STANDARD_CONTEXT_WINDOW)
  expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000)
})

it('puts the auto-compact threshold where the SDK does: 167k of 200k, 967k of 1M', () => {
  expect(autoCompactThreshold(200_000)).toBe(167_000)
  expect(autoCompactThreshold(1_000_000)).toBe(967_000)
})

it('never puts the threshold below nothing, however small the window', () => {
  expect(autoCompactThreshold(30_000)).toBe(0)
})
