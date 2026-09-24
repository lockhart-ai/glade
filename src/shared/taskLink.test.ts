import { describe, expect, it } from 'vitest'
import { taskLink } from './taskLink'

describe('taskLink', () => {
  it('links to a task by its id', () => {
    expect(taskLink('0b8d4f2e')).toBe('glade://task/0b8d4f2e')
    expect(taskLink('a/b c')).toBe('glade://task/a%2Fb%20c')
  })
})
