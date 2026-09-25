// Test helpers: tiny made-up images of each type the agent takes, as base64, for tests on both sides of the bridge.
import { ImageMediaType, type ImageData } from './images'

/** A 1×1 PNG. */
export const PNG: ImageData = {
  mediaType: ImageMediaType.Png,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
}

/** A JPEG's first bytes: enough to be one. */
export const JPEG: ImageData = { mediaType: ImageMediaType.Jpeg, data: '/9j/4AAQSkZJRg==' }

/** A 1×1 GIF. */
export const GIF: ImageData = {
  mediaType: ImageMediaType.Gif,
  data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
}

/** A 1×1 WebP. */
export const WEBP: ImageData = {
  mediaType: ImageMediaType.Webp,
  data: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
}
