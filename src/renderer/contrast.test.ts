import { expect, it } from 'vitest'
import { contrastRatio, relativeLuminance } from './contrast'

it('gives black on white 21:1, in either order', () => {
  expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21)
  expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21)
})

it('gives identical colours 1:1', () => {
  expect(contrastRatio('#5b8def', '#5b8def')).toBe(1)
})

it('matches a published WCAG value', () => {
  // #767676 on white is the classic "just passes AA" grey: 4.54:1.
  expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
})

it('rejects anything but #rrggbb', () => {
  expect(() => relativeLuminance('#fff')).toThrow('Not a #rrggbb colour: #fff')
})
