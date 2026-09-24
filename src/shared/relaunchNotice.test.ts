import { describe, expect, it } from 'vitest'
import { parseRelaunchNotice, serializeRelaunchNotice } from './relaunchNotice'

describe('the relaunch notice', () => {
  it('round-trips through its UI state value', () => {
    const notice = { taskIds: ['task-1', 'task-2'] }

    expect(parseRelaunchNotice(serializeRelaunchNotice(notice))).toEqual(notice)
  })

  it.each([
    ['unset', undefined],
    ['dismissed', ''],
    ['not JSON', '{'],
    ['not an object', '"task-1"'],
    ['null', 'null'],
    ['without tasks', '{"taskIds":[]}'],
    ['with a task id that is not a string', '{"taskIds":["task-1",2]}'],
  ])('is no notice when %s', (_, value) => {
    expect(parseRelaunchNotice(value)).toBeNull()
  })
})
