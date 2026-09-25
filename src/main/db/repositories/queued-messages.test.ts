import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRole, type Task } from '../../../shared/domain'
import { ImageMediaType } from '../../../shared/images'
import { GIF, JPEG, PNG } from '../../../shared/test-images'
import { getImage, ImageOwnerKind, imagesOf } from './images'
import { listMessages } from './messages'
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
      images: [],
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
  it("delivers only this task's queue to its chat log, in order, and empties it", () => {
    const other = sampleTask(test.db, task.workspaceId)
    queue('One')
    const elsewhere = queue('Elsewhere', other.id)
    queue('Two')

    const delivered = takeQueuedMessages(test.db, task.id, 2, 9_000)

    const expected = (body: string) => ({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      taskId: task.id,
      role: MessageRole.User,
      body,
      turn: 2,
      createdAt: 9_000,
      summary: null,
      images: [],
    })
    expect(delivered).toEqual([expected('One'), expected('Two')])
    expect(listMessages(test.db, task.id)).toEqual(delivered)
    expect(listQueuedMessages(test.db, task.id)).toEqual([])
    expect(listQueuedMessages(test.db, other.id)).toEqual([elsewhere])
    expect(takeQueuedMessages(test.db, task.id, 3)).toEqual([])
  })

  it('moves each message’s images to the message it’s delivered as, keeping their ids and order', () => {
    const first = appendQueuedMessage(test.db, { taskId: task.id, body: 'Two shots', images: [PNG, JPEG] })
    const second = appendQueuedMessage(test.db, { taskId: task.id, body: '', images: [GIF] })

    const [one, two] = takeQueuedMessages(test.db, task.id, 1)

    expect(one?.images).toEqual(first.images)
    expect(two?.images).toEqual(second.images)
    expect(listMessages(test.db, task.id).map(({ images }) => images)).toEqual([first.images, second.images])
    const owner = (id: string) => ({ kind: ImageOwnerKind.Message, id })
    expect(imagesOf(test.db, owner(one?.id ?? ''))).toEqual([PNG, JPEG])
    expect(imagesOf(test.db, owner(two?.id ?? ''))).toEqual([GIF])
  })
})

describe('queued images', () => {
  it('keeps a message’s images with it, in order, as it’s listed, found and edited', () => {
    const message = appendQueuedMessage(test.db, { taskId: task.id, body: 'See these', images: [PNG, JPEG, GIF] })

    expect(message.images.map(({ mediaType }) => mediaType)).toEqual([
      ImageMediaType.Png,
      ImageMediaType.Jpeg,
      ImageMediaType.Gif,
    ])
    expect(listQueuedMessages(test.db, task.id)).toEqual([message])
    expect(getQueuedMessage(test.db, message.id)).toEqual(message)
    expect(updateQueuedMessage(test.db, message.id, 'See these three')).toEqual({ ...message, body: 'See these three' })
    expect(imagesOf(test.db, { kind: ImageOwnerKind.QueuedMessage, id: message.id })).toEqual([PNG, JPEG, GIF])
  })

  it('drops a message’s images when it’s removed', () => {
    const message = appendQueuedMessage(test.db, { taskId: task.id, body: '', images: [PNG] })
    const [image] = message.images

    deleteQueuedMessage(test.db, message.id)

    expect(getImage(test.db, image?.id ?? '')).toBeUndefined()
  })

  it('adds nothing when an image can’t be stored', () => {
    const bad = { mediaType: 'image/tiff' as ImageMediaType, data: PNG.data }
    expect(() => appendQueuedMessage(test.db, { taskId: task.id, body: 'Hi', images: [PNG, bad] })).toThrow(/CHECK/)
    expect(listQueuedMessages(test.db, task.id)).toEqual([])
    expect(test.db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(0)
  })
})
