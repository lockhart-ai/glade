import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../../shared/domain'
import {
  appendQueuedMessage,
  deleteQueuedMessage,
  getQueuedMessage,
  listQueuedMessages,
  takeQueuedMessages,
  updateQueuedMessage,
} from './queued-messages'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

const queue = (body: string, taskId = task.id, now = 3_000) => appendQueuedMessage(test.db, { taskId, body }, now)

describe('appendQueuedMessage', () => {
  it('adds a message with a new UUID to the end of the queue', () => {
    const first = queue('Keep the original filenames in the bucket keys.')

    expect(first).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      taskId: task.id,
      body: 'Keep the original filenames in the bucket keys.',
      createdAt: 3_000,
    })
    const second = queue('When the copy finishes, tell me how many files failed.')
    expect(listQueuedMessages(test.db, task.id)).toEqual([first, second])
  })

  it('defaults the time to now', () => {
    const before = Date.now()
    expect(appendQueuedMessage(test.db, { taskId: task.id, body: 'Hi' }).createdAt).toBeGreaterThanOrEqual(before)
  })

  it('refuses a message for an unknown task', () => {
    expect(() => queue('Hi', 'missing')).toThrow('FOREIGN KEY constraint failed')
  })
})

describe('listQueuedMessages', () => {
  it("lists only this task's queue, in order, even when times tie", () => {
    const other = sampleTask(test.db, task.workspaceId)
    const first = queue('One')
    queue('Elsewhere', other.id)
    const second = queue('Two')

    expect(listQueuedMessages(test.db, task.id)).toEqual([first, second])
  })

  it('keeps adding at the end after messages leave the queue', () => {
    const first = queue('One')
    const second = queue('Two')
    deleteQueuedMessage(test.db, second.id)
    const third = queue('Three')

    expect(listQueuedMessages(test.db, task.id)).toEqual([first, third])
  })
})

describe('getQueuedMessage', () => {
  it('finds a queued message, or nothing once it has left the queue', () => {
    const message = queue('Hi')
    expect(getQueuedMessage(test.db, message.id)).toEqual(message)
    deleteQueuedMessage(test.db, message.id)
    expect(getQueuedMessage(test.db, message.id)).toBeUndefined()
  })
})

describe('updateQueuedMessage', () => {
  it('changes the text and keeps the place', () => {
    const first = queue('One')
    const second = queue('Two')

    const edited = updateQueuedMessage(test.db, first.id, 'One, edited')

    expect(edited).toEqual({ ...first, body: 'One, edited' })
    expect(listQueuedMessages(test.db, task.id)).toEqual([edited, second])
  })

  it('is undefined for a message that is not queued', () => {
    expect(updateQueuedMessage(test.db, 'missing', 'Hi')).toBeUndefined()
  })
})

describe('deleteQueuedMessage', () => {
  it('removes one message, and says whether there was one', () => {
    const first = queue('One')
    const second = queue('Two')

    expect(deleteQueuedMessage(test.db, first.id)).toBe(true)
    expect(deleteQueuedMessage(test.db, first.id)).toBe(false)
    expect(listQueuedMessages(test.db, task.id)).toEqual([second])
  })
})

describe('takeQueuedMessages', () => {
  it("empties only this task's queue and answers with what it held, in order", () => {
    const other = sampleTask(test.db, task.workspaceId)
    const first = queue('One')
    const elsewhere = queue('Elsewhere', other.id)
    const second = queue('Two')

    expect(takeQueuedMessages(test.db, task.id)).toEqual([first, second])
    expect(listQueuedMessages(test.db, task.id)).toEqual([])
    expect(listQueuedMessages(test.db, other.id)).toEqual([elsewhere])
    expect(takeQueuedMessages(test.db, task.id)).toEqual([])
  })
})
