import { expect, it } from 'vitest'
import { shortenHomePath } from './paths'
import { setHomeFolder } from '../shared/homeFolder'

// The sample data's home folder, which paths under it are shown from as `~`.
setHomeFolder('/Users/sam')

it('shortens a path under a home folder to start with ~', () => {
  expect(shortenHomePath('/Users/sam/code/api')).toBe('~/code/api')
  expect(shortenHomePath('/Users/sam')).toBe('~')
})

it('leaves other paths alone', () => {
  expect(shortenHomePath('/code/api')).toBe('/code/api')
  expect(shortenHomePath('/Volumes/Users/sam/api')).toBe('/Volumes/Users/sam/api')
  expect(shortenHomePath('/Users')).toBe('/Users')
})
