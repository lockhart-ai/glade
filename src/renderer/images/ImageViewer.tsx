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
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
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

/** The image `by` places on from `index`, clamped to the first or last image rather than going round (#463). */
export function steppedIndex(index: number, by: number, count: number): number {
  const next = index + by
  if (next < 0) return 0
  if (next >= count) return count - 1
  return next
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
  /**
   * Whether closing it puts the focus on the task's input instead of `returnFocus` (#415): true for a message's
   * pasted images, in the chat or queued. False (the default) for a workspace image, opened from the Artifacts tab or
   * the Files tab, where closing keeps a keyboard user's place in the list or row it opened from instead.
   */
  readonly focusesTaskInput?: boolean
}

/**
 * A message's pasted images, or a task's workspace files (an artifact, or the file showing in the Files tab), at full
 * size, over the window (`docs/design/screens/30-image-viewer.png`, `docs/design/screens/35-artifact-image.png`): the
 * one showing as large as fits the window but never larger than it is, on the Settings modal's dimmed backdrop. With
 * several, a pager under it says which ("2 of 3") and steps between them, as ← and → do, stopping at the first and
 * last image rather than going round (#463); its own buttons disable there too, and one that held the focus hands it
 * to the viewer, so the keys keep stepping. A workspace image with a header shows its title just above the image's
 * own left edge, over the backdrop rather than the image's pixels, truncating rather than crowding its actions, which
 * keep their place in the close chip, top right, so nothing sits under the macOS traffic lights (top left, in every
 * state) (#460). Esc, a click on the backdrop or the close button closes it. It takes the focus synchronously as it's
 * shown, so a ← or → pressed right away still steps it (#393), and hands the focus back to `returnFocus` once it
 * closes — or, for a message's pasted images, to the task's input instead (`focusesTaskInput`, #415).
 */
export function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
  returnFocus,
  header,
  focusesTaskInput = false,
}: ImageViewerProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const overlay = useOverlayRef()
  // Open for as long as it's mounted (its parent unmounts it to close it): while it is, and only when it's the kind
  // that takes the task's input over on close, the input bar holds off taking the focus itself, even though
  // `returnFocus` lands it here first; the task's input takes it over once this unmounts (#415). A workspace image
  // (an artifact, or a Files tab file) never registers here, so closing it always leaves the focus on `returnFocus`.
  useModalPresence(focusesTaskInput)
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

  // A pager button that holds the focus as it disables (Next, clicked onto the last image; Previous, onto the first)
  // can't keep it: Chromium drops the focus of a control that disables onto the page's body with its next frame, out
  // of the viewer, where ← and → no longer reach `onKeyDown` and nothing steps back. The viewer itself takes the
  // focus first, in the same commit that disables the button: the keys still land in it, and ↵ or Space pressed again
  // does nothing there, rather than stepping the other way or closing it.
  useLayoutEffect(() => {
    const viewer = refs.floating.current
    const focused = document.activeElement
    if (viewer !== null && focused instanceof HTMLButtonElement && focused.disabled && viewer.contains(focused)) {
      viewer.focus({ preventScroll: true })
    }
  }, [index, refs])

  const multiple = images.length > 1
  const atFirst = index === 0
  const atLast = index === images.length - 1
  const step = (by: number): void => {
    const next = steppedIndex(index, by, images.length)
    // At an end already (#463): ← on the first, or → on the last, does nothing.
    if (next !== index) onIndexChange?.(next)
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
            {images.map((source, at) => {
              const isShown = at === index
              // Only the shown image's title renders (the rest are hidden anyway): `chrome` is already just its.
              const title = isShown ? chrome?.title : undefined
              return (
                <div key={imageSourceKey(source)} className={styles.frame} hidden={!isShown}>
                  {title !== undefined && (
                    <span className={styles.title} title={title} data-testid="image-viewer-title">
                      {title}
                    </span>
                  )}
                  <ViewedImage source={source} />
                </div>
              )
            })}
            <div className={styles.close}>
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
                  disabled={atFirst}
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
                  disabled={atLast}
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
}

/**
 * An image at its own size or as large as fits; in its place, a card that says it can't be loaded. Its `.frame`
 * wrapper (above) carries `hidden` while another of the images is showing, so each stays loaded and stepping back to
 * it is instant.
 */
function ViewedImage({ source }: ViewedImageProps): React.JSX.Element | null {
  switch (source.kind) {
    case ImageSourceKind.Pasted:
      return <PastedViewedImage source={source} />
    case ImageSourceKind.Workspace:
      return <WorkspaceViewedImage source={source} />
  }
}

/** In place of an image that can't be loaded: a card that says so. */
function MissingImage(): React.JSX.Element {
  return (
    <div role="img" aria-label={MISSING_IMAGE_LABEL} className={styles.missing}>
      <Icon icon={faImage} size={IconSize.Large} />
      {MISSING_IMAGE_LABEL}
    </div>
  )
}

function PastedViewedImage({
  source,
}: {
  readonly source: Extract<ImageViewerSource, { kind: ImageSourceKind.Pasted }>
}): React.JSX.Element | null {
  const state = useStoredImage(source.ref)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return null
    case StoredImageStatus.Missing:
      return <MissingImage />
    case StoredImageStatus.Loaded:
      return <img src={state.url} alt={IMAGE_LABEL} className={styles.image} />
  }
}

function WorkspaceViewedImage({
  source,
}: {
  readonly source: Extract<ImageViewerSource, { kind: ImageSourceKind.Workspace }>
}): React.JSX.Element | null {
  const state = useWorkspaceImage(source.taskId, source.path)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return null
    case StoredImageStatus.Missing:
      return <MissingImage />
    case StoredImageStatus.Loaded:
      return <img src={state.url} alt={source.title} className={styles.image} />
  }
}
