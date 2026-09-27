import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { faImage } from '@fortawesome/free-regular-svg-icons'
import { faChevronLeft, faChevronRight, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import type { ImageRef } from '../../shared/images'
import { Button, ButtonVariant, Icon, IconSize, useOverlayRef } from '../components'
import { IMAGE_LABEL, MISSING_IMAGE_LABEL, StoredImageStatus, useStoredImage } from './StoredImage'
import styles from './ImageViewer.module.css'

/** What the viewer is called to a screen reader. */
export const VIEWER_LABEL = 'Image viewer'

/** "2 of 3": which of a message's images is showing, counted from 1. */
export function imagePosition(index: number, count: number): string {
  return `${String(index + 1)} of ${String(count)}`
}

/** The image `step` places on from `index`, going round from the last to the first and back. */
export function steppedIndex(index: number, step: number, count: number): number {
  return (((index + step) % count) + count) % count
}

export interface ImageViewerProps {
  /** The message's images, in order; the viewer shows one at a time. */
  readonly images: readonly ImageRef[]
  /** The one showing. */
  readonly index: number
  readonly onIndexChange: (index: number) => void
  /** Called for Esc, a click on the backdrop, or the close button. */
  readonly onClose: () => void
  /** Where the focus goes once it closes: the thumbnail of the image it was showing. */
  readonly returnFocus: React.RefObject<HTMLElement | null>
}

/**
 * A message's pasted images at full size, over the window (`docs/design/screens/30-image-viewer.png`): the one showing
 * as large as fits the window but never larger than it is, on the Settings modal's dimmed backdrop. With several, a
 * pager under it says which ("2 of 3") and steps between them, as ← and → do, going round at the ends. Esc, a click on
 * the backdrop or the close button closes it. It takes the focus while it's open and hands it back to `returnFocus`.
 */
export function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
  returnFocus,
}: ImageViewerProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const overlay = useOverlayRef()
  const { refs, context } = useFloating({
    open: true,
    onOpenChange: (next) => {
      if (!next) onClose()
    },
  })
  const setFloating = useCallback(
    (node: HTMLElement | null) => {
      refs.setFloating(node)
    },
    [refs],
  )
  // The viewer fills the window, so a click on the backdrop lands on it: it closes itself (`onBackdropClick`).
  const { getFloatingProps } = useInteractions([
    useDismiss(context, { outsidePress: false }),
    useRole(context, { role: 'dialog' }),
  ])
  const multiple = images.length > 1
  const step = (by: number): void => {
    onIndexChange(steppedIndex(index, by, images.length))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!multiple || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    // Its fixed keys, as the keymap has them (`WindowCommandId.StepImage`).
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      step(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }

  const onBackdropClick = (event: MouseEvent<HTMLElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <FloatingPortal>
      <FloatingOverlay ref={overlay} className={styles.backdrop} lockScroll>
        <FloatingFocusManager context={context} initialFocus={closeRef} returnFocus={returnFocus}>
          <div
            ref={setFloating}
            className={styles.viewer}
            aria-label={VIEWER_LABEL}
            {...getFloatingProps({ onKeyDown, onClick: onBackdropClick })}
          >
            {images.map((image, shown) => (
              <ViewedImage key={image.id} image={image} hidden={shown !== index} />
            ))}
            <div className={styles.close}>
              <Button
                ref={closeRef}
                variant={ButtonVariant.Icon}
                icon={faXmark}
                aria-label="Close image"
                title="Close image"
                onClick={onClose}
              />
            </div>
            {multiple && (
              <div role="group" aria-label="Images" className={styles.pager}>
                <Button
                  variant={ButtonVariant.Icon}
                  icon={faChevronLeft}
                  aria-label="Previous image"
                  title="Previous image"
                  onClick={() => {
                    step(-1)
                  }}
                />
                <span aria-live="polite" className={styles.position}>
                  {imagePosition(index, images.length)}
                </span>
                <Button
                  variant={ButtonVariant.Icon}
                  icon={faChevronRight}
                  aria-label="Next image"
                  title="Next image"
                  onClick={() => {
                    step(1)
                  }}
                />
              </div>
            )}
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  )
}

interface ViewedImageProps {
  readonly image: ImageRef
  /** Whether another of the message's images is showing: each stays loaded, so stepping back to it is instant. */
  readonly hidden: boolean
}

/** An image at its own size or as large as fits; in its place, a card that says it can't be loaded. */
function ViewedImage({ image, hidden }: ViewedImageProps): React.JSX.Element | null {
  const state = useStoredImage(image)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return null
    case StoredImageStatus.Missing:
      return (
        <div role="img" aria-label={MISSING_IMAGE_LABEL} className={styles.missing} hidden={hidden}>
          <Icon icon={faImage} size={IconSize.Large} />
          {MISSING_IMAGE_LABEL}
        </div>
      )
    case StoredImageStatus.Loaded:
      return <img src={state.url} alt={IMAGE_LABEL} className={styles.image} hidden={hidden} />
  }
}
