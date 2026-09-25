import { expect, it } from 'vitest'
import { GIF, PNG, WEBP } from '../../shared/test-images'
import { userContent } from './user-content'

it('is just the text for a message without images', () => {
  expect(userContent('Fix the flaky test.')).toBe('Fix the flaky test.')
  expect(userContent('Fix the flaky test.', [])).toBe('Fix the flaky test.')
})

it('is an image block for each image, in order, then the text', () => {
  expect(userContent('Which is right?', [GIF, PNG])).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: GIF.data } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.data } },
    { type: 'text', text: 'Which is right?' },
  ])
})

it('leaves out the text block for a message that is only images, which the API would refuse empty', () => {
  expect(userContent('', [WEBP])).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: WEBP.data } },
  ])
  expect(userContent(' \n', [WEBP])).toHaveLength(1)
})
