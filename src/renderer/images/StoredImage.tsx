import { useEffect, useState } from 'react'
import { imageDataUrl, type ImageRef } from '../../shared/images'
import { useGladeStore } from '../store/react'

/** What a stored image is called to a screen reader: it has no caption of its own. */
export const IMAGE_LABEL = 'Pasted image'
/** What an image that can't be loaded is called, in its place. */
export const MISSING_IMAGE_LABEL = 'Image not available'

/** Where loading a stored image has got to. */
export enum StoredImageStatus {
  Loading = 'loading',
  Loaded = 'loaded',
  /** It can't be loaded: main doesn't have it, or reading it failed. */
  Missing = 'missing',
}

/** A stored image as it loads: nothing yet, its data URL, or that it can't be loaded. */
export type StoredImageState =
  | { readonly status: StoredImageStatus.Loading }
  | { readonly status: StoredImageStatus.Loaded; readonly url: string }
  | { readonly status: StoredImageStatus.Missing }

/** What's known about loading an image, and which image it's about. */
interface Loaded {
  /** The image loaded, so a new image doesn't show the last one's state. */
  readonly id: string
  readonly url: string | null
}

const LOADING: StoredImageState = { status: StoredImageStatus.Loading }
const MISSING: StoredImageState = { status: StoredImageStatus.Missing }

/**
 * Loads an image saved with a message from main by id (`loadImage`, which keeps each one once it's loaded), as a data
 * URL: never a remote one.
 */
export function useStoredImage(image: ImageRef): StoredImageState {
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

  if (loaded?.id !== image.id) return LOADING
  return loaded.url === null ? MISSING : { status: StoredImageStatus.Loaded, url: loaded.url }
}

export interface StoredImageProps {
  readonly image: ImageRef
  /** Sizes and shapes it: the thumbnail's size, border and radius. */
  readonly className?: string
}

/**
 * An image saved with a message (in the chat or the queue), fetched from main by id. Until it has loaded, and if it
 * can't be, an empty box of the same size stands in for it.
 */
export function StoredImage({ image, className }: StoredImageProps): React.JSX.Element {
  const state = useStoredImage(image)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return <span role="img" aria-label={IMAGE_LABEL} className={className} />
    case StoredImageStatus.Missing:
      return <span role="img" aria-label={MISSING_IMAGE_LABEL} className={className} />
    case StoredImageStatus.Loaded:
      return <img src={state.url} alt={IMAGE_LABEL} className={className} />
  }
}
