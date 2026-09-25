// The images pasted into messages (migration 20): each belongs to one message in the chat log or one waiting in the
// queue, in the order it was pasted. Messages carry just their images' refs; the bytes are read on their own, to show
// an image or to hand it to the agent.
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { ImageMediaType, type ImageData, type ImageRef } from '../../../shared/images'
import { Row } from './rows'

/** What an image can belong to. */
export enum ImageOwnerKind {
  Message = 'message',
  QueuedMessage = 'queued_message',
}

/** The message or queued message an image belongs to. */
export interface ImageOwner {
  readonly kind: ImageOwnerKind
  readonly id: string
}

/** Images to store with a message. */
export interface NewImages {
  readonly taskId: string
  readonly owner: ImageOwner
  readonly images: readonly ImageData[]
}

const MEDIA_TYPES = Object.values(ImageMediaType)

/** The column that names an owner of its kind. */
function ownerColumn(kind: ImageOwnerKind): string {
  switch (kind) {
    case ImageOwnerKind.Message:
      return 'message_id'
    case ImageOwnerKind.QueuedMessage:
      return 'queued_message_id'
  }
}

function parseRef(raw: unknown): ImageRef {
  const row = new Row('images', raw)
  return { id: row.text('id'), mediaType: row.oneOf('media_type', MEDIA_TYPES) }
}

function parseData(raw: unknown): ImageData {
  const row = new Row('images', raw)
  return { mediaType: row.oneOf('media_type', MEDIA_TYPES), data: row.blob('data').toString('base64') }
}

/** Stores a message's images, in order, answering with their refs. */
export function addImages(db: Database, input: NewImages, now: EpochMs = Date.now()): ImageRef[] {
  const insert = db.prepare(
    `INSERT INTO images (id, task_id, ${ownerColumn(input.owner.kind)}, position, media_type, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  return input.images.map((image, position) => {
    const id = randomUUID()
    insert.run(id, input.taskId, input.owner.id, position, image.mediaType, Buffer.from(image.data, 'base64'), now)
    return { id, mediaType: image.mediaType }
  })
}

/** A message's images' refs, in order. */
export function imageRefsOf(db: Database, owner: ImageOwner): ImageRef[] {
  return db
    .prepare(`SELECT id, media_type FROM images WHERE ${ownerColumn(owner.kind)} = ? ORDER BY position`)
    .all(owner.id)
    .map(parseRef)
}

/** The refs of every image of a task's messages of one kind, by message id, each in order. */
export function imageRefsByOwner(db: Database, taskId: string, kind: ImageOwnerKind): Map<string, ImageRef[]> {
  const column = ownerColumn(kind)
  const byOwner = new Map<string, ImageRef[]>()
  const rows = db
    .prepare(
      `SELECT id, media_type, ${column} AS owner FROM images WHERE task_id = ? AND ${column} IS NOT NULL
      ORDER BY position`,
    )
    .all(taskId)
  for (const raw of rows) {
    const owner = new Row('images', raw).text('owner')
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), parseRef(raw)])
  }
  return byOwner
}

/** A message's images with their bytes, in order: what the agent gets with it. */
export function imagesOf(db: Database, owner: ImageOwner): ImageData[] {
  return db
    .prepare(`SELECT media_type, data FROM images WHERE ${ownerColumn(owner.kind)} = ? ORDER BY position`)
    .all(owner.id)
    .map(parseData)
}

/** An image's type and bytes, or undefined when there's no such image. */
export function getImage(db: Database, id: string): ImageData | undefined {
  const row: unknown = db.prepare('SELECT media_type, data FROM images WHERE id = ?').get(id)
  return row === undefined ? undefined : parseData(row)
}

/** Moves a queued message's images to the message it was delivered as, keeping their ids and order. */
export function moveQueuedImages(db: Database, queuedMessageId: string, messageId: string): void {
  db.prepare('UPDATE images SET message_id = ?, queued_message_id = NULL WHERE queued_message_id = ?').run(
    messageId,
    queuedMessageId,
  )
}
