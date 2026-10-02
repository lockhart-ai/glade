import { useMemo, useRef, useState } from 'react'
import type { ImageRef } from '../../shared/images'
import { classNames } from '../components/classNames'
import { ImageViewer, imagePosition } from './ImageViewer'
import { pastedImageSource } from './imageSources'
import { StoredImage } from './StoredImage'
import styles from './ImageThumbnails.module.css'

/** What a thumbnail is called to a screen reader: "View pasted image", and which one when there are several. */
export function thumbnailLabel(index: number, count: number): string {
  return count > 1 ? `View pasted image ${imagePosition(index, count)}` : 'View pasted image'
}

export interface ImageThumbnailsProps {
  /** A message's images, in order. */
  readonly images: readonly ImageRef[]
  /** Sizes and shapes each thumbnail: its width, height, border and radius. */
  readonly className?: string
}

/**
 * The images pasted into a message, in the chat or the queue, as thumbnails that open the image viewer
 * (`docs/design/screens/30-image-viewer.png`): each a button, so a click, ↵ or Space opens it. The viewer steps
 * through the message's images, and once it closes, the focus is back on the thumbnail of the one it showed.
 */
export function ImageThumbnails({ images, className }: ImageThumbnailsProps): React.JSX.Element {
  const [viewing, setViewing] = useState<number | null>(null)
  const thumbnails = useRef<(HTMLButtonElement | null)[]>([])
  const returnFocus = useRef<HTMLElement | null>(null)
  const sources = useMemo(() => images.map(pastedImageSource), [images])

  // The image it showed is no longer the message's: it closes, and stays closed if the image comes back.
  if (viewing !== null && viewing >= images.length) setViewing(null)

  const view = (index: number | null): void => {
    if (index !== null) returnFocus.current = thumbnails.current[index] ?? null
    setViewing(index)
  }

  return (
    <>
      {images.map((image, index) => (
        <button
          key={image.id}
          ref={(element) => {
            thumbnails.current[index] = element
          }}
          type="button"
          aria-label={thumbnailLabel(index, images.length)}
          className={classNames(styles.thumbnail, className)}
          onClick={() => {
            view(index)
          }}
        >
          <StoredImage image={image} className={styles.image} />
        </button>
      ))}
      {viewing !== null && viewing < images.length && (
        <ImageViewer
          images={sources}
          index={viewing}
          onIndexChange={view}
          onClose={() => {
            view(null)
          }}
          returnFocus={returnFocus}
          focusesTaskInput
        />
      )}
    </>
  )
}
