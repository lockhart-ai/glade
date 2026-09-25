import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRole, type Task } from '../../../shared/domain'
import { GIF, JPEG, PNG, WEBP } from '../../../shared/test-images'
import {
  addImages,
  getImage,
  ImageOwnerKind,
  imageRefsByOwner,
  imageRefsOf,
  imagesOf,
  moveQueuedImages,
} from './images'
import { appendMessage } from './messages'
import { appendQueuedMessage } from './queued-messages'
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

const message = (taskId = task.id) =>
  appendMessage(test.db, { taskId, role: MessageRole.User, body: 'See this', turn: 1 })
const asMessage = (id: string) => ({ kind: ImageOwnerKind.Message, id })
const asQueued = (id: string) => ({ kind: ImageOwnerKind.QueuedMessage, id })

describe('addImages', () => {
  it('stores each image in order, answering with a ref to each', () => {
    const { id } = message()
    const refs = addImages(test.db, { taskId: task.id, owner: asMessage(id), images: [PNG, JPEG, GIF, WEBP] })

    expect(refs).toEqual([
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, mediaType: PNG.mediaType },
      { id: expect.any(String) as unknown, mediaType: JPEG.mediaType },
      { id: expect.any(String) as unknown, mediaType: GIF.mediaType },
      { id: expect.any(String) as unknown, mediaType: WEBP.mediaType },
    ])
    expect(new Set(refs.map((ref) => ref.id)).size).toBe(4)
    expect(imageRefsOf(test.db, asMessage(id))).toEqual(refs)
    expect(imagesOf(test.db, asMessage(id))).toEqual([PNG, JPEG, GIF, WEBP])
  })

  it('stores nothing for a message without images', () => {
    const { id } = message()
    expect(addImages(test.db, { taskId: task.id, owner: asMessage(id), images: [] })).toEqual([])
    expect(imageRefsOf(test.db, asMessage(id))).toEqual([])
  })

  it('keeps the same image pasted twice as two images', () => {
    const { id } = message()
    const [first, second] = addImages(test.db, { taskId: task.id, owner: asMessage(id), images: [PNG, PNG] })
    expect(first?.id).not.toBe(second?.id)
    expect(imagesOf(test.db, asMessage(id))).toEqual([PNG, PNG])
  })

  it('refuses an image for a message that isn’t there', () => {
    expect(() => addImages(test.db, { taskId: task.id, owner: asMessage('missing'), images: [PNG] })).toThrow(
      'FOREIGN KEY constraint failed',
    )
  })
})

describe('getImage', () => {
  it('reads an image’s bytes back exactly, or nothing for no such image', () => {
    const { id } = message()
    const large = { mediaType: PNG.mediaType, data: Buffer.alloc(300_000, 7).toString('base64') }
    const [small, big] = addImages(test.db, { taskId: task.id, owner: asMessage(id), images: [GIF, large] })

    expect(getImage(test.db, small?.id ?? '')).toEqual(GIF)
    expect(getImage(test.db, big?.id ?? '')).toEqual(large)
    expect(getImage(test.db, 'missing')).toBeUndefined()
  })
})

describe('imageRefsByOwner', () => {
  it('groups a task’s images by message, each in order, leaving out other kinds and tasks', () => {
    const other = sampleTask(test.db, task.workspaceId)
    const first = message()
    const second = message()
    const elsewhere = message(other.id)
    const queued = appendQueuedMessage(test.db, { taskId: task.id, body: '', images: [WEBP] })
    const firstRefs = addImages(test.db, { taskId: task.id, owner: asMessage(first.id), images: [PNG, JPEG] })
    const secondRefs = addImages(test.db, { taskId: task.id, owner: asMessage(second.id), images: [GIF] })
    addImages(test.db, { taskId: other.id, owner: asMessage(elsewhere.id), images: [PNG] })

    expect(imageRefsByOwner(test.db, task.id, ImageOwnerKind.Message)).toEqual(
      new Map([
        [first.id, firstRefs],
        [second.id, secondRefs],
      ]),
    )
    expect(imageRefsByOwner(test.db, task.id, ImageOwnerKind.QueuedMessage)).toEqual(
      new Map([[queued.id, queued.images]]),
    )
  })
})

describe('moveQueuedImages', () => {
  it('moves a queued message’s images to a message, keeping their ids and order', () => {
    const queued = appendQueuedMessage(test.db, { taskId: task.id, body: '', images: [PNG, GIF] })
    const delivered = message()

    moveQueuedImages(test.db, queued.id, delivered.id)

    expect(imageRefsOf(test.db, asQueued(queued.id))).toEqual([])
    expect(imageRefsOf(test.db, asMessage(delivered.id))).toEqual(queued.images)
    expect(imagesOf(test.db, asMessage(delivered.id))).toEqual([PNG, GIF])
  })
})
