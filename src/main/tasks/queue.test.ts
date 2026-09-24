import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import type { Task } from '../../shared/domain'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { addQueuedMessage, editQueuedMessage, removeQueuedMessage } from './queue'

let database: TestDatabase
let task: Task
const emit = vi.fn()

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  emit.mockReset()
})

afterEach(() => {
  database.close()
})

const context = () => ({ db: database.db, emit })

/** A failure's code, for comparing. */
function failure(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return error instanceof Error && 'code' in error ? error.code : error
  }
  return undefined
}

describe('addQueuedMessage', () => {
  it('adds to the end of the queue and broadcasts the whole queue', () => {
    const first = addQueuedMessage(context(), task.id, 'Keep the original filenames.')
    const second = addQueuedMessage(context(), task.id, 'Tell me how many files failed.')

    expect(listQueuedMessages(database.db, task.id)).toEqual([first, second])
    expect(emit.mock.calls).toEqual([
      [{ type: EventType.QueueChanged, taskId: task.id, queuedMessages: [first] }],
      [{ type: EventType.QueueChanged, taskId: task.id, queuedMessages: [first, second] }],
    ])
  })

  it('fails with not_found for no such task', () => {
    expect(failure(() => addQueuedMessage(context(), 'missing', 'Hi'))).toBe(BridgeErrorCode.NotFound)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('editQueuedMessage', () => {
  it('changes the text in place and broadcasts the queue', () => {
    const first = addQueuedMessage(context(), task.id, 'Keep the filenames.')
    const second = addQueuedMessage(context(), task.id, 'Then report.')
    emit.mockReset()

    const edited = editQueuedMessage(context(), first.id, 'Keep the original filenames in the bucket keys.')

    expect(edited).toEqual({ ...first, body: 'Keep the original filenames in the bucket keys.' })
    expect(listQueuedMessages(database.db, task.id)).toEqual([edited, second])
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: EventType.QueueChanged,
      taskId: task.id,
      queuedMessages: [edited, second],
    })
  })

  it('fails with not_found once the message has left the queue', () => {
    const message = addQueuedMessage(context(), task.id, 'Hi')
    removeQueuedMessage(context(), message.id)
    emit.mockReset()

    expect(failure(() => editQueuedMessage(context(), message.id, 'Hello'))).toBe(BridgeErrorCode.NotFound)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('removeQueuedMessage', () => {
  it('removes the message and broadcasts the queue', () => {
    const first = addQueuedMessage(context(), task.id, 'One')
    const second = addQueuedMessage(context(), task.id, 'Two')
    emit.mockReset()

    removeQueuedMessage(context(), first.id)

    expect(listQueuedMessages(database.db, task.id)).toEqual([second])
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.QueueChanged, taskId: task.id, queuedMessages: [second] })
  })

  it('fails with not_found for a message that is not queued', () => {
    expect(failure(() => removeQueuedMessage(context(), 'missing'))).toBe(BridgeErrorCode.NotFound)
  })
})
