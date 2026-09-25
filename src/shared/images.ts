/**
 * Images pasted into the input bar, which go to the agent with their message as image content blocks. What the Claude
 * API takes decides what can be attached: PNG, JPEG, GIF or WebP, up to 5 MB of base64 each.
 */

/** The image types the agent takes, by MIME type. */
export enum ImageMediaType {
  Png = 'image/png',
  Jpeg = 'image/jpeg',
  Gif = 'image/gif',
  Webp = 'image/webp',
}

/** A stored image, as a message refers to it: its bytes are fetched on their own (`images.get`). */
export interface ImageRef {
  readonly id: string
  readonly mediaType: ImageMediaType
}

/** An image's type and bytes, as base64: what's pasted, sent to main and handed to the agent. */
export interface ImageData {
  readonly mediaType: ImageMediaType
  /** The image's bytes, base64-encoded. */
  readonly data: string
}

/** The API's limit on one image: 5 MB, counted on its base64. */
export const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024

/** The largest image file that fits the API's limit once base64-encoded: 3.75 MB. */
export const MAX_IMAGE_BYTES = (MAX_IMAGE_BASE64_LENGTH / 4) * 3

const MEDIA_TYPES: readonly string[] = Object.values(ImageMediaType)

/** Whether a MIME type is one the agent takes. */
export function isImageMediaType(type: string): type is ImageMediaType {
  return MEDIA_TYPES.includes(type)
}

/** What's known about a pasted file before it's read. */
export interface PastedFile {
  /** Its MIME type, `''` when the clipboard didn't say. */
  readonly type: string
  readonly size: number
  readonly name: string
}

/** Whether a pasted file can be attached, and if not, why. */
export type AttachCheck =
  { readonly ok: true; readonly mediaType: ImageMediaType } | { readonly ok: false; readonly reason: string }

/** A pasted file's name, for a refusal: one pasted from the clipboard may have none. */
export function pastedFileName(name: string): string {
  return name === '' ? 'The pasted file' : name
}

/** Checks a pasted file against what the agent takes: its type, then its size. */
export function checkPastedFile(file: PastedFile): AttachCheck {
  if (!isImageMediaType(file.type)) {
    return {
      ok: false,
      reason: `${pastedFileName(file.name)} can’t be attached: only PNG, JPEG, GIF and WebP images can.`,
    }
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `${pastedFileName(file.name)} is too large: images can be up to 3.75 MB.` }
  }
  return { ok: true, mediaType: file.type }
}

/** The first bytes of each type's files. WebP's are `RIFF`, 4 bytes of size, then `WEBP`. */
const SIGNATURES: Readonly<Record<ImageMediaType, (bytes: Uint8Array) => boolean>> = {
  [ImageMediaType.Png]: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  [ImageMediaType.Jpeg]: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  [ImageMediaType.Gif]: (bytes) => startsWith(bytes, [0x47, 0x49, 0x46, 0x38]),
  [ImageMediaType.Webp]: (bytes) =>
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]),
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}

/** Whether an image's bytes are the type it says: the API refuses an image whose bytes don't match its type. */
export function hasImageSignature(mediaType: ImageMediaType, bytes: Uint8Array): boolean {
  return SIGNATURES[mediaType](bytes)
}

/** An image as a `data:` URL, for an `<img>` (the renderer's CSP allows `data:` images). */
export function imageDataUrl(image: ImageData): string {
  return `data:${image.mediaType};base64,${image.data}`
}
