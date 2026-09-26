/**
 * Thumbnails of the images a task declared as artifacts, for their rows in the Artifacts tab (#307). macOS makes them
 * (Electron's `nativeImage.createThumbnailFromPath`, Quick Look), off the main thread, a few at a time; each is kept as
 * a PNG in a folder under the app's data, named for the file's path, size and when it last changed, so a file that
 * changes gets a new one and one that doesn't is never made twice. A file that can't be made into one (broken, or a
 * kind Quick Look can't read) has none, and isn't tried again while the app runs.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** The folder under the app's data the thumbnails are kept in. */
export const THUMBNAILS_FOLDER_NAME = 'thumbnails'

/**
 * The most a thumbnail's longer side is, in pixels: a row shows it 40×28, cropped to fill, on a 2× screen, so even a
 * tall screenshot keeps enough across.
 */
export const THUMBNAIL_EDGE = 160

/** The largest image a thumbnail is made of, in bytes. A larger one shows its type. */
export const MAX_THUMBNAIL_SOURCE_BYTES = 64 * 1024 * 1024

/** How many thumbnails are made at once. */
export const THUMBNAIL_CONCURRENCY = 4

/** How much of the start of a file is read to check it's the image its name says: enough for an SVG's prolog. */
export const IMAGE_HEAD_BYTES = 4096

/** The kinds of image a thumbnail is made of, by extension (lowercase, without the dot), and how each file starts. */
const IMAGE_SIGNATURES: Readonly<Record<string, (head: Buffer) => boolean>> = {
  png: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  jpeg: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  gif: (head) => ['GIF87a', 'GIF89a'].includes(head.toString('latin1', 0, 6)),
  webp: (head) => head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP',
  svg: (head) => head.toString('utf8').includes('<svg'),
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

/** Whether a file is an image a thumbnail is made of, by its name: PNG, JPEG, GIF, WebP or SVG. */
export function isThumbnailImage(path: string): boolean {
  return extensionOf(path) in IMAGE_SIGNATURES
}

/**
 * Whether a file starts as the image its name says it is (its first `IMAGE_HEAD_BYTES`). Quick Look makes a picture
 * of a generic document of one that isn't, which isn't a thumbnail of it: such a file shows its type instead.
 */
export function startsAsImage(path: string, head: Buffer): boolean {
  return IMAGE_SIGNATURES[extensionOf(path)]?.(head) ?? false
}

/** The size a thumbnail is made to fit in. */
export interface ThumbnailSize {
  readonly width: number
  readonly height: number
}

/** The part of Electron's `NativeImage` a thumbnail needs. */
export interface ThumbnailImage {
  isEmpty(): boolean
  toPNG(): Buffer
}

/** The part of Electron's `nativeImage` that makes thumbnails, so tests can stand in a fake. */
export interface NativeThumbnails {
  createThumbnailFromPath(path: string, size: ThumbnailSize): Promise<ThumbnailImage>
}

/** An image to make a thumbnail of: its real path, and its size and last change, which name its thumbnail. */
export interface ThumbnailSource {
  readonly realPath: string
  readonly size: number
  readonly modifiedMs: number
}

/** Makes thumbnails and keeps them. */
export interface Thumbnails {
  /** A PNG thumbnail of the image, as a `data:` URL; null when none can be made of it. Never rejects. */
  thumbnailOf(source: ThumbnailSource): Promise<string | null>
}

/** No thumbnails at all: what the bridge has when it isn't given any (tests). */
export const NO_THUMBNAILS: Thumbnails = { thumbnailOf: () => Promise.resolve(null) }

export interface ThumbnailsOptions {
  /** The folder to keep them in, made when the first is: `<userData>/thumbnails`. */
  readonly folder: string
  readonly native: NativeThumbnails
  /** How many are made at once. `THUMBNAIL_CONCURRENCY` by default. */
  readonly concurrency?: number
}

/** What names an image's thumbnail: a hash of its real path, size and last change. */
export function thumbnailKey({ realPath, size, modifiedMs }: ThumbnailSource): string {
  return createHash('sha256')
    .update(JSON.stringify([realPath, size, modifiedMs]))
    .digest('hex')
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/** Runs tasks at most `limit` at a time, in the order they were asked for. */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  const next = (): void => {
    running--
    waiting.shift()?.()
  }
  return async (task) => {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    running++
    try {
      return await task()
    } finally {
      next()
    }
  }
}

/**
 * Thumbnails kept in `folder`. An image asked for again while its thumbnail is being made waits for that one; one
 * already made is read from the folder. A thumbnail that can't be kept (the folder can't be written) is still answered.
 */
export function createThumbnails({
  folder,
  native,
  concurrency = THUMBNAIL_CONCURRENCY,
}: ThumbnailsOptions): Thumbnails {
  const limit = createLimiter(concurrency)
  const pending = new Map<string, Promise<string | null>>()
  // The images no thumbnail could be made of, while the app runs: a change to one names it anew.
  const failed = new Set<string>()

  const kept = async (file: string): Promise<Buffer | null> => {
    try {
      return await readFile(file)
    } catch {
      return null
    }
  }

  const keep = async (file: string, png: Buffer): Promise<void> => {
    try {
      await mkdir(folder, { recursive: true })
      // Written aside and moved into place, so a thumbnail read at the same time is never half written.
      const partial = `${file}.${String(process.pid)}.partial`
      await writeFile(partial, png)
      await rename(partial, file)
    } catch {
      // Not kept: it's made again next time.
    }
  }

  const make = async (source: ThumbnailSource, file: string): Promise<string | null> => {
    const existing = await kept(file)
    if (existing !== null) return dataUrl(existing)
    let png: Buffer
    try {
      const image = await limit(() =>
        native.createThumbnailFromPath(source.realPath, { width: THUMBNAIL_EDGE, height: THUMBNAIL_EDGE }),
      )
      png = image.isEmpty() ? Buffer.alloc(0) : image.toPNG()
    } catch {
      png = Buffer.alloc(0)
    }
    if (png.length === 0) return null
    await keep(file, png)
    return dataUrl(png)
  }

  return {
    thumbnailOf(source) {
      const key = thumbnailKey(source)
      if (failed.has(key)) return Promise.resolve(null)
      const inFlight = pending.get(key)
      if (inFlight !== undefined) return inFlight
      const made = make(source, join(folder, `${key}.png`)).then((url) => {
        pending.delete(key)
        if (url === null) failed.add(key)
        return url
      })
      pending.set(key, made)
      return made
    },
  }
}
