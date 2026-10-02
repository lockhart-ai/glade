import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
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
import { Button, ButtonVariant, Icon, IconSize, useModalPresence, useOverlayRef } from '../components'
import { ImageSourceKind, imageSourceKey, type ImageViewerSource } from './imageSources'
import { IMAGE_LABEL, MISSING_IMAGE_LABEL, StoredImageStatus, useStoredImage, useWorkspaceImage } from './StoredImage'
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

/** One of the header's actions over the image showing, e.g. Open in Files or Reveal in Finder. */
export interface ImageViewerAction {
  readonly icon: IconDefinition
  readonly label: string
  readonly onClick: () => void
}

/** What shows over the image showing, for the source it's for. */
export interface ImageViewerHeader {
  readonly title: string
  readonly actions: readonly ImageViewerAction[]
}

export interface ImageViewerProps {
  /** The images the viewer steps through, in order. */
  readonly images: readonly ImageViewerSource[]
  /** The one showing. */
  readonly index: number
  /** Called to step to another image; left out for a single image, which never steps. */
  readonly onIndexChange?: (index: number) => void
  /** Called for Esc, a click on the backdrop, or the close button. */
  readonly onClose: () => void
  /** Where the focus goes once it closes: the thumbnail, or row, of the image it was showing. */
  readonly returnFocus: React.RefObject<HTMLElement | null>
  /**
   * What the header over the image showing says and does, for its source; undefined for none. A message's pasted
   * images have no header; a workspace image opened from the Artifacts tab has its artifact's title, Open in Files and
   * Reveal in Finder.
   */
  readonly header?: (source: ImageViewerSource) => ImageViewerHeader | undefined
}

/**
 * A message's pasted images, or a task's workspace files (an artifact, or the file showing in the Files tab), at full
 * size, over the window (`docs/design/screens/30-image-viewer.png`, `docs/design/screens/35-artifact-image.png`): the
 * one showing as large as fits the window but never larger than it is, on the Settings modal's dimmed backdrop. With
 * several, a pager under it says which ("2 of 3") and steps between them, as ← and → do, going round at the ends. A
 * workspace image with a header shows its title in the close chip, before its actions, all top right, so nothing sits
 * under the macOS traffic lights (top left, in every state). Esc, a click on the backdrop or the close button closes
 * it. It takes the focus synchronously as it's shown, so a ← or → pressed right away still steps it (#393), and hands
 * the focus back to `returnFocus` once it closes.
 */
export function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
  returnFocus,
  header,
}: ImageViewerProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const overlay = useOverlayRef()
  // Open for as long as it's mounted (its parent unmounts it to close it): while it is, the input bar holds off
  // taking the focus, even though `returnFocus` lands it here first; the task's input takes it over once this unmounts
  // (#415).
  useModalPresence(true)
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
  // `FloatingFocusManager` below also focuses `closeRef` as its `initialFocus`, but only on the next animation
  // frame (it waits for the portal it renders into), which leaves a window right after opening where a key still
  // goes to whatever had the focus before (#393). Focusing the close button the moment it mounts, from its own ref
  // callback rather than a layout effect of this component (which would run before the portal's own mount and find
  // nothing to focus yet), closes that window; the later call just re-confirms the same element.
  const focusOnMount = useCallback((node: HTMLButtonElement | null) => {
    closeRef.current = node
    node?.focus({ preventScroll: true })
  }, [])

  const multiple = images.length > 1
  const step = (by: number): void => {
    onIndexChange?.(steppedIndex(index, by, images.length))
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

  const shown = images[index]
  const chrome = shown === undefined ? undefined : header?.(shown)

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
            {images.map((source, at) => (
              <ViewedImage key={imageSourceKey(source)} source={source} hidden={at !== index} />
            ))}
            <div className={styles.close}>
              {chrome !== undefined && (
                <span className={styles.chipTitle} title={chrome.title} data-testid="image-viewer-title">
                  {chrome.title}
                </span>
              )}
              {chrome?.actions.map((action) => (
                <Button
                  key={action.label}
                  variant={ButtonVariant.Icon}
                  icon={action.icon}
                  aria-label={action.label}
                  title={action.label}
                  onClick={action.onClick}
                />
              ))}
              <Button
                ref={focusOnMount}
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
  readonly source: ImageViewerSource
  /** Whether another of the images is showing: each stays loaded, so stepping back to it is instant. */
  readonly hidden: boolean
}

/** An image at its own size or as large as fits; in its place, a card that says it can't be loaded. */
function ViewedImage({ source, hidden }: ViewedImageProps): React.JSX.Element | null {
  switch (source.kind) {
    case ImageSourceKind.Pasted:
      return <PastedViewedImage source={source} hidden={hidden} />
    case ImageSourceKind.Workspace:
      return <WorkspaceViewedImage source={source} hidden={hidden} />
  }
}

/** In place of an image that can't be loaded: a card that says so. */
function MissingImage({ hidden }: { readonly hidden: boolean }): React.JSX.Element {
  return (
    <div role="img" aria-label={MISSING_IMAGE_LABEL} className={styles.missing} hidden={hidden}>
      <Icon icon={faImage} size={IconSize.Large} />
      {MISSING_IMAGE_LABEL}
    </div>
  )
}

function PastedViewedImage({
  source,
  hidden,
}: {
  readonly source: Extract<ImageViewerSource, { kind: ImageSourceKind.Pasted }>
  readonly hidden: boolean
}): React.JSX.Element | null {
  const state = useStoredImage(source.ref)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return null
    case StoredImageStatus.Missing:
      return <MissingImage hidden={hidden} />
    case StoredImageStatus.Loaded:
      return <img src={state.url} alt={IMAGE_LABEL} className={styles.image} hidden={hidden} />
  }
}

function WorkspaceViewedImage({
  source,
  hidden,
}: {
  readonly source: Extract<ImageViewerSource, { kind: ImageSourceKind.Workspace }>
  readonly hidden: boolean
}): React.JSX.Element | null {
  const state = useWorkspaceImage(source.taskId, source.path)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return null
    case StoredImageStatus.Missing:
      return <MissingImage hidden={hidden} />
    case StoredImageStatus.Loaded:
      return <img src={state.url} alt={source.title} className={styles.image} hidden={hidden} />
  }
}
