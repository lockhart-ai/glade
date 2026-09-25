import { describe, expect, it } from 'vitest'
import {
  checkPastedFile,
  hasImageSignature,
  imageDataUrl,
  ImageMediaType,
  isImageMediaType,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_BYTES,
  pastedFileName,
} from './images'
import { GIF, JPEG, PNG, WEBP } from './test-images'

const bytes = (data: string): Uint8Array => Uint8Array.from(Buffer.from(data, 'base64'))

describe('isImageMediaType', () => {
  it('takes the four types the agent takes, and nothing else', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(isImageMediaType(type)).toBe(true)
    for (const type of ['image/tiff', 'image/svg+xml', 'image/heic', 'application/pdf', 'IMAGE/PNG', '']) {
      expect(isImageMediaType(type)).toBe(false)
    }
  })
})

describe('the size limit', () => {
  it('is the largest file whose base64 fits the API’s 5 MB', () => {
    expect(MAX_IMAGE_BASE64_LENGTH).toBe(5_242_880)
    expect(MAX_IMAGE_BYTES).toBe(3_932_160)
    // Base64 takes 4 characters for every 3 bytes.
    expect(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).toBe(MAX_IMAGE_BASE64_LENGTH)
    expect(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4).toBeGreaterThan(MAX_IMAGE_BASE64_LENGTH)
  })
})

describe('checkPastedFile', () => {
  it('attaches each supported type, up to the limit exactly', () => {
    for (const type of Object.values(ImageMediaType)) {
      expect(checkPastedFile({ type, size: MAX_IMAGE_BYTES, name: 'shot' })).toEqual({ ok: true, mediaType: type })
    }
    expect(checkPastedFile({ type: 'image/png', size: 0, name: '' })).toEqual({ ok: true, mediaType: 'image/png' })
  })

  it('refuses an unsupported type, by name, saying which types it takes', () => {
    expect(checkPastedFile({ type: 'image/tiff', size: 10, name: 'scan.tiff' })).toEqual({
      ok: false,
      reason: 'scan.tiff can’t be attached: only PNG, JPEG, GIF and WebP images can.',
    })
    expect(checkPastedFile({ type: 'application/pdf', size: 10, name: 'notes.pdf' })).toMatchObject({ ok: false })
  })

  it('refuses a file with no type, which the clipboard didn’t name', () => {
    expect(checkPastedFile({ type: '', size: 10, name: '' })).toEqual({
      ok: false,
      reason: 'The pasted file can’t be attached: only PNG, JPEG, GIF and WebP images can.',
    })
  })

  it('refuses an image one byte over the limit, saying what the limit is', () => {
    expect(checkPastedFile({ type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1, name: 'photo.jpg' })).toEqual({
      ok: false,
      reason: 'photo.jpg is too large: images can be up to 3.75 MB.',
    })
  })

  it('names an unsupported file by its type before its size', () => {
    expect(checkPastedFile({ type: 'image/bmp', size: MAX_IMAGE_BYTES * 2, name: 'big.bmp' })).toMatchObject({
      reason: expect.stringContaining('only PNG, JPEG, GIF and WebP') as unknown,
    })
  })
})

describe('pastedFileName', () => {
  it('names a file by its name, or as the pasted file when it has none', () => {
    expect(pastedFileName('shot.png')).toBe('shot.png')
    expect(pastedFileName('')).toBe('The pasted file')
  })
})

describe('hasImageSignature', () => {
  it('knows each type’s bytes', () => {
    for (const image of [PNG, JPEG, GIF, WEBP]) expect(hasImageSignature(image.mediaType, bytes(image.data))).toBe(true)
  })

  it('refuses bytes of another type, or too few to tell', () => {
    expect(hasImageSignature(ImageMediaType.Png, bytes(JPEG.data))).toBe(false)
    expect(hasImageSignature(ImageMediaType.Jpeg, bytes(GIF.data))).toBe(false)
    expect(hasImageSignature(ImageMediaType.Gif, bytes(WEBP.data))).toBe(false)
    expect(hasImageSignature(ImageMediaType.Webp, bytes(PNG.data))).toBe(false)
    expect(hasImageSignature(ImageMediaType.Png, new Uint8Array([0x89, 0x50]))).toBe(false)
    expect(hasImageSignature(ImageMediaType.Jpeg, new Uint8Array())).toBe(false)
  })

  it('checks both halves of a WebP’s header', () => {
    // A RIFF file that isn't WebP, such as a WAV.
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    expect(hasImageSignature(ImageMediaType.Webp, wav)).toBe(false)
  })
})

describe('imageDataUrl', () => {
  it('makes a data URL of the image’s type and bytes', () => {
    expect(imageDataUrl(GIF)).toBe(`data:image/gif;base64,${GIF.data}`)
  })
})
