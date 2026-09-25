import { useEffect, useState } from 'react'
import { imageDataUrl, type ImageRef } from '../../shared/images'
import { useGladeStore } from '../store/react'

/** What a stored image is called to a screen reader: it has no caption of its own. */
export const IMAGE_LABEL = 'Pasted image'
/** What an image that can't be loaded is called, in its place. */
export const MISSING_IMAGE_LABEL = 'Image not available'

export interface StoredImageProps {
  readonly image: ImageRef
  /** Sizes and shapes it: the thumbnail's size, border and radius. */
  readonly className?: string
}

/** What's known about loading an image: nothing yet, its URL, or that it failed. */
interface Loaded {
  /** The image loaded, so a new image doesn't show the last one's state. */
  readonly id: string
  readonly url: string | null
}

/**
 * An image saved with a message (in the chat or the queue), fetched from main by id (`loadImage`). Until it has
 * loaded, and if it can't be, an empty box of the same size stands in for it.
 */
export function StoredImage({ image, className }: StoredImageProps): React.JSX.Element {
  const loadImage = useGladeStore((state) => state.loadImage)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let current = true
    loadImage(image.id).then(
      (data) => {
        if (current) setLoaded({ id: image.id, url: imageDataUrl(data) })
      },
      () => {
        if (current) setLoaded({ id: image.id, url: null })
      },
    )
    return () => {
      current = false
    }
  }, [image.id, loadImage])

  const state = loaded?.id === image.id ? loaded : null
  if (state?.url == null) {
    return <span role="img" aria-label={state === null ? IMAGE_LABEL : MISSING_IMAGE_LABEL} className={className} />
  }
  return <img src={state.url} alt={IMAGE_LABEL} className={className} />
}
