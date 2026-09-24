import { expect, it } from 'vitest'
import { classNames } from './classNames'

it('joins the class names that are set', () => {
  expect(classNames('a', false, undefined, '', 'b')).toBe('a b')
})

it('returns an empty string when none are set', () => {
  expect(classNames(false, undefined)).toBe('')
})
