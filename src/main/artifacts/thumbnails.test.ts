import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createThumbnails,
  isThumbnailImage,
  NO_THUMBNAILS,
  startsAsImage,
  THUMBNAIL_CONCURRENCY,
  THUMBNAIL_EDGE,
  thumbnailKey,
  type NativeThumbnails,
  type ThumbnailImage,
  type ThumbnailSource,
} from './thumbnails'

let data: string
let folder: string

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'glade-thumbnails-'))
  folder = join(data, 'thumbnails')
})

afterEach(() => {
  rmSync(data, { recursive: true, force: true })
})

const LANDING: ThumbnailSource = { realPath: '/code/acme-api/out/landing-dark.png', size: 48_213, modifiedMs: 1_000 }

/** A made thumbnail: the PNG's bytes, here just the path it was made of. */
function image(path: string): ThumbnailImage {
  return { isEmpty: () => false, toPNG: () => Buffer.from(`png of ${path}`) }
}

const EMPTY: ThumbnailImage = { isEmpty: () => true, toPNG: () => Buffer.alloc(0) }

function urlOf(path: string): string {
  return `data:image/png;base64,${Buffer.from(`png of ${path}`).toString('base64')}`
}

/** Quick Look, making a thumbnail of each path at once. */
function quickLook(make: (path: string) => Promise<ThumbnailImage> = (path) => Promise.resolve(image(path))) {
  return { createThumbnailFromPath: vi.fn<NativeThumbnails['createThumbnailFromPath']>(make) }
}

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('isThumbnailImage', () => {
  it('is a PNG, JPEG, GIF, WebP or SVG, whatever the case of its extension', () => {
    for (const path of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'out/Shot.PNG', 'x.JpEg']) {
      expect(isThumbnailImage(path), path).toBe(true)
    }
  })

  it('is nothing else: other files, no extension, a dot file, or an image name in a folder', () => {
    for (const path of ['notes.md', 'report.pdf', 'icon.ico', 'Makefile', '.png', 'png', 'shots.png/readme.txt']) {
      expect(isThumbnailImage(path), path).toBe(false)
    }
  })
})

describe('startsAsImage', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb])

  it('knows each kind of image by how it starts', () => {
    expect(startsAsImage('a.png', PNG)).toBe(true)
    expect(startsAsImage('b.JPG', JPEG)).toBe(true)
    expect(startsAsImage('c.jpeg', JPEG)).toBe(true)
    expect(startsAsImage('d.gif', Buffer.from('GIF87a..'))).toBe(true)
    expect(startsAsImage('e.gif', Buffer.from('GIF89a..'))).toBe(true)
    expect(startsAsImage('f.webp', Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 '))).toBe(true)
    // An SVG may have a prolog, a comment or a doctype before its root.
    expect(startsAsImage('g.svg', Buffer.from('<?xml version="1.0"?>\n<!-- Acme -->\n<svg viewBox="0 0 1 1"/>'))).toBe(
      true,
    )
  })

  it('refuses one that starts as something else, is cut short, or isn’t an image at all', () => {
    expect(startsAsImage('a.png', JPEG)).toBe(false)
    expect(startsAsImage('a.png', PNG.subarray(0, 4))).toBe(false)
    expect(startsAsImage('a.png', Buffer.alloc(0))).toBe(false)
    expect(startsAsImage('b.jpg', PNG)).toBe(false)
    expect(startsAsImage('d.gif', Buffer.from('GIF90a'))).toBe(false)
    expect(startsAsImage('f.webp', Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt '))).toBe(false)
    expect(startsAsImage('g.svg', Buffer.from('<html><body/></html>'))).toBe(false)
    expect(startsAsImage('notes.md', Buffer.from('<svg/>'))).toBe(false)
  })
})

describe('thumbnailKey', () => {
  it('names an image by its path, size and last change', () => {
    const key = thumbnailKey(LANDING)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(thumbnailKey({ ...LANDING })).toBe(key)
    expect(thumbnailKey({ ...LANDING, realPath: '/code/acme-api/out/landing-light.png' })).not.toBe(key)
    expect(thumbnailKey({ ...LANDING, size: LANDING.size + 1 })).not.toBe(key)
    expect(thumbnailKey({ ...LANDING, modifiedMs: LANDING.modifiedMs + 1 })).not.toBe(key)
  })
})

describe('NO_THUMBNAILS', () => {
  it('makes none', async () => {
    await expect(NO_THUMBNAILS.thumbnailOf(LANDING)).resolves.toBeNull()
  })
})

describe('createThumbnails', () => {
  it('makes a thumbnail to fit the edge with Quick Look, keeps it in its folder, and answers it as a data URL', async () => {
    const native = quickLook()
    const thumbnails = createThumbnails({ folder, native })

    await expect(thumbnails.thumbnailOf(LANDING)).resolves.toBe(urlOf(LANDING.realPath))

    expect(native.createThumbnailFromPath).toHaveBeenCalledExactlyOnceWith(LANDING.realPath, {
      width: THUMBNAIL_EDGE,
      height: THUMBNAIL_EDGE,
    })
    expect(readdirSync(folder)).toEqual([`${thumbnailKey(LANDING)}.png`])
    expect(readFileSync(join(folder, `${thumbnailKey(LANDING)}.png`), 'utf8')).toBe(`png of ${LANDING.realPath}`)
  })

  it('reads a kept thumbnail back rather than making it again, after a relaunch too', async () => {
    const native = quickLook()
    const thumbnails = createThumbnails({ folder, native })
    await thumbnails.thumbnailOf(LANDING)

    await expect(thumbnails.thumbnailOf(LANDING)).resolves.toBe(urlOf(LANDING.realPath))
    const relaunched = quickLook()
    await expect(createThumbnails({ folder, native: relaunched }).thumbnailOf(LANDING)).resolves.toBe(
      urlOf(LANDING.realPath),
    )

    expect(native.createThumbnailFromPath).toHaveBeenCalledOnce()
    expect(relaunched.createThumbnailFromPath).not.toHaveBeenCalled()
  })

  it('makes a new one when the file changes', async () => {
    let version = 1
    const native = quickLook((path) =>
      Promise.resolve({ isEmpty: () => false, toPNG: () => Buffer.from(`${path} v${String(version)}`) }),
    )
    const thumbnails = createThumbnails({ folder, native })
    const first = await thumbnails.thumbnailOf(LANDING)

    version = 2
    const changed = await thumbnails.thumbnailOf({ ...LANDING, modifiedMs: 2_000, size: 50_000 })

    expect(native.createThumbnailFromPath).toHaveBeenCalledTimes(2)
    expect(changed).not.toBe(first)
    expect(changed).toBe(`data:image/png;base64,${Buffer.from(`${LANDING.realPath} v2`).toString('base64')}`)
  })

  it('makes one thumbnail of an image asked for again while it’s being made', async () => {
    const made = deferred<ThumbnailImage>()
    const native = quickLook(() => made.promise)
    const thumbnails = createThumbnails({ folder, native })

    const asked = [thumbnails.thumbnailOf(LANDING), thumbnails.thumbnailOf({ ...LANDING })]
    made.resolve(image(LANDING.realPath))

    await expect(Promise.all(asked)).resolves.toEqual([urlOf(LANDING.realPath), urlOf(LANDING.realPath)])
    expect(native.createThumbnailFromPath).toHaveBeenCalledOnce()
  })

  it('has none of a broken image, or one Quick Look makes nothing of, and doesn’t try it again', async () => {
    const native = quickLook((path) =>
      path.endsWith('broken.png') ? Promise.reject(new Error('Failed to get thumbnail')) : Promise.resolve(EMPTY),
    )
    const thumbnails = createThumbnails({ folder, native })
    const broken = { ...LANDING, realPath: '/code/acme-api/out/broken.png' }
    const blank = { ...LANDING, realPath: '/code/acme-api/out/blank.svg' }

    await expect(thumbnails.thumbnailOf(broken)).resolves.toBeNull()
    await expect(thumbnails.thumbnailOf(blank)).resolves.toBeNull()
    await expect(thumbnails.thumbnailOf(broken)).resolves.toBeNull()
    await expect(thumbnails.thumbnailOf(blank)).resolves.toBeNull()

    expect(native.createThumbnailFromPath).toHaveBeenCalledTimes(2)
    expect(existsSync(folder)).toBe(false)
    // Fixed, it names a new thumbnail, which is made.
    native.createThumbnailFromPath.mockImplementation((path) => Promise.resolve(image(path)))
    await expect(thumbnails.thumbnailOf({ ...broken, modifiedMs: 5_000 })).resolves.toBe(urlOf(broken.realPath))
  })

  it(`makes at most ${String(THUMBNAIL_CONCURRENCY)} at once, starting the next as each finishes`, async () => {
    const making = new Map<string, ReturnType<typeof deferred<ThumbnailImage>>>()
    const native = quickLook((path) => {
      const made = deferred<ThumbnailImage>()
      making.set(path, made)
      return made.promise
    })
    const thumbnails = createThumbnails({ folder, native })
    const paths = Array.from({ length: 10 }, (_, index) => `/code/acme-api/out/shot-${String(index)}.png`)

    const asked = paths.map((realPath) => thumbnails.thumbnailOf({ ...LANDING, realPath }))
    await vi.waitFor(() => {
      expect(making.size).toBe(THUMBNAIL_CONCURRENCY)
    })

    // As each finishes, the next starts, never more than the limit at once.
    for (let finished = 1; finished <= paths.length; finished++) {
      const [path, made] = [...making.entries()][finished - 1] ?? []
      if (path === undefined || made === undefined) throw new Error(`only ${String(making.size)} started`)
      made.resolve(image(path))
      await vi.waitFor(() => {
        expect(making.size).toBe(Math.min(paths.length, finished + THUMBNAIL_CONCURRENCY))
      })
    }
    await expect(Promise.all(asked)).resolves.toEqual(paths.map(urlOf))
    expect(native.createThumbnailFromPath).toHaveBeenCalledTimes(paths.length)
  })

  it('takes its own limit, and one that fails makes way for the next', async () => {
    const first = deferred<ThumbnailImage>()
    const native = quickLook((path) => (path.endsWith('a.png') ? first.promise : Promise.resolve(image(path))))
    const thumbnails = createThumbnails({ folder, native, concurrency: 1 })

    const a = thumbnails.thumbnailOf({ ...LANDING, realPath: '/a.png' })
    await vi.waitFor(() => {
      expect(native.createThumbnailFromPath).toHaveBeenCalledOnce()
    })
    const b = thumbnails.thumbnailOf({ ...LANDING, realPath: '/b.png' })
    // It waits its turn while the first is being made.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(native.createThumbnailFromPath).toHaveBeenCalledOnce()
    first.reject(new Error('Failed to get thumbnail'))

    await expect(a).resolves.toBeNull()
    await expect(b).resolves.toBe(urlOf('/b.png'))
  })

  it('still answers a thumbnail it can’t keep, and makes it again next time', async () => {
    // Where the folder should be, a file: nothing can be kept in it.
    writeFileSync(folder, 'in the way')
    const native = quickLook()
    const thumbnails = createThumbnails({ folder, native })

    await expect(thumbnails.thumbnailOf(LANDING)).resolves.toBe(urlOf(LANDING.realPath))
    await expect(thumbnails.thumbnailOf(LANDING)).resolves.toBe(urlOf(LANDING.realPath))

    expect(native.createThumbnailFromPath).toHaveBeenCalledTimes(2)
  })
})
