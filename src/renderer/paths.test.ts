import { expect, it } from 'vitest'
import { shortenHomePath } from './paths'

it('shortens a path under a home folder to start with ~', () => {
  expect(shortenHomePath('/Users/sam/code/api')).toBe('~/code/api')
  expect(shortenHomePath('/Users/sam')).toBe('~')
})

it('leaves other paths alone', () => {
  expect(shortenHomePath('/code/api')).toBe('/code/api')
  expect(shortenHomePath('/Volumes/Users/sam/api')).toBe('/Volumes/Users/sam/api')
  expect(shortenHomePath('/Users')).toBe('/Users')
})
