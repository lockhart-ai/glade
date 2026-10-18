import { expect, it } from 'vitest'
import { hashLines } from './instruction-hash'

it('is the same for the same lines in the same order, and different for a different one', () => {
  expect(hashLines(['a', 'b'])).toBe(hashLines(['a', 'b']))
  expect(hashLines(['a', 'b'])).not.toBe(hashLines(['b', 'a']))
  expect(hashLines(['a', 'b'])).not.toBe(hashLines(['a']))
  expect(hashLines([])).toBe(hashLines([]))
})

it('tells apart two lines joined as one from the same two lines kept separate', () => {
  // A naive join (e.g. '\n\n'.join) could collide; this must not.
  expect(hashLines(['ab', 'c'])).not.toBe(hashLines(['a', 'bc']))
})
