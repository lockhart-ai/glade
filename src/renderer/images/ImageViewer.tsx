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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, ButtonVariant, Icon, IconSize, useModalPresence, useOverlayRef } from '../components'
import { ImageSourceKind, imageSourceKey, type ImageViewerSource } from './imageSources'
import { IMAGE_LABEL, MISSING_IMAGE_LABEL, StoredImageStatus, useStoredImage, useWorkspaceImage } from './StoredImage'
import { naturalSizeOf, useImageZoom } from './useImageZoom'
import type { Size } from './zoomModel'
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
   * images have no header; a workspace image opened from the Todos tab has its artifact's title, Open in Files and
   * Reveal in Finder.
   */
  readonly header?: (source: ImageViewerSource) => ImageViewerHeader | undefined
  /**
   * Whether closing it puts the focus on the task's input instead of `returnFocus` (#415): true for a message's
   * pasted images, in the chat or queued. False (the default) for a workspace image, opened from the Todos tab or
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
 * state) (#460); it appears with the image, once that has loaded and has its size, never before it (#478). Esc, a
 * click on the backdrop or the close button closes it. It takes the focus synchronously as it's shown, image loaded or
 * not, so a ← or → pressed right away still steps it (#393), and hands the focus back to `returnFocus` once it closes
 * — or, for a message's pasted images, to the task's input instead (`focusesTaskInput`, #415).
 *
 * The image showing zooms (#685), by `useImageZoom`: the trackpad's pinch zooms around the pointer, ⌘+ and ⌘− zoom,
 * ⌘0 returns to fit, a click on the image toggles fit and actual size at the clicked spot, and zoomed in, a drag or
 * a scroll pans. Stepping to another image starts it at that one's fit. While the viewer shows, the View menu's zoom
 * items zoom it rather than the page.
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
  // The zoom of the image showing (#685): the view is the whole viewer — the image may cover it all once zoomed in —
  // and the fit keeps the room the close button and the pager take (96 across, 160 down), as the image's own CSS did.
  const [natural, setNatural] = useState<Size | null>(null)
  const onNatural = useCallback((size: Size | null): void => {
    setNatural((previous) =>
      previous === size ||
      (previous !== null && size !== null && previous.width === size.width && previous.height === size.height)
        ? previous
        : size,
    )
  }, [])
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

  const shown = images[index]
  const chrome = shown === undefined ? undefined : header?.(shown)
  // The zoom belongs to the image showing: another one starts at its own fit, and its natural size comes from its
  // frame, which reports it once it's the one showing (it may have loaded while another was).
  const imageKey = shown === undefined ? '' : imageSourceKey(shown)
  const [shownKey, setShownKey] = useState(imageKey)
  if (shownKey !== imageKey) {
    setShownKey(imageKey)
    setNatural(null)
  }
  const {
    viewRef,
    frameRef,
    frameStyle: zoomFrameStyle,
  } = useImageZoom({
    natural,
    imageKey,
    frameInset: { width: 1, height: 1 },
    fitRoom: { width: 96, height: 160 },
    takesKeys: true,
    onBlankClick: onClose,
  })

  return (
    <FloatingPortal>
      <FloatingOverlay ref={overlay} className={styles.backdrop} lockScroll>
        <FloatingFocusManager context={context} initialFocus={closeRef} returnFocus={returnFocus}>
          <div
            ref={setFloating}
            className={styles.viewer}
            aria-label={VIEWER_LABEL}
            {...getFloatingProps({ onKeyDown })}
          >
            <div className={styles.zoomView} ref={viewRef}>
              {images.map((source, at) => {
                const isShown = at === index
                // Only the shown image's title renders (the rest are hidden anyway): `chrome` is already just its.
                return (
                  <ViewerFrame
                    key={imageSourceKey(source)}
                    source={source}
                    shown={isShown}
                    title={isShown ? chrome?.title : undefined}
                    frameRef={isShown ? frameRef : undefined}
                    frameStyle={isShown ? zoomFrameStyle : undefined}
                    onNatural={onNatural}
                  />
                )
              })}
            </div>
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

interface ViewerFrameProps {
  readonly source: ImageViewerSource
  /** Whether it's the one showing: the others stay mounted, hidden, so each stays loaded and stepping to it is instant. */
  readonly shown: boolean
  /** The title to put above it (the shown image's, when it has one); undefined for none. */
  readonly title: string | undefined
  /** Where the zoom places the frame, while it's the one showing; undefined to lay it out as the CSS does (at fit). */
  readonly frameStyle: React.CSSProperties | undefined
  /** Set while this is the one showing, so the zoom can place it and tell a click on it from one beside it. */
  readonly frameRef: ((node: HTMLDivElement | null) => void) | undefined
  /** Reports the image's natural size, once loaded, to the viewer — which zooms the frame it's showing. */
  readonly onNatural: (size: Size | null) => void
}

/**
 * One of the viewer's images in its frame, with its title above it. An image has no size until the browser has loaded
 * it: until then its element is an empty box 2px wide (its border), in the middle of the window, and before that,
 * while its file is being read, there's no element at all. A title placed against either would be a sliver somewhere
 * the image won't be. So the frame isn't painted, and its title isn't in the document, until what it holds has its
 * size (`sized`); that one state shows both, in the same commit, so the title is never a frame ahead of the image or
 * behind it, and never anywhere but on its edge (#478). Once the image showing has its natural size, the zoom
 * (`useImageZoom`) places the frame at its box; until then the CSS lays it out at fit, which is where the box puts it.
 */
function ViewerFrame({ source, shown, title, frameStyle, frameRef, onNatural }: ViewerFrameProps): React.JSX.Element {
  const [sized, setSized] = useState(false)
  const [natural, setNatural] = useState<Size | null>(null)
  const onSized = useCallback(() => {
    setSized(true)
  }, [])
  const onImageNatural = useCallback((size: Size | null): void => {
    setNatural(size)
  }, [])
  // The viewer zooms the frame it's showing: this one reports its own size — including one it already had, from
  // loading while another image was showing, the moment it becomes the one showing.
  useEffect(() => {
    if (shown) onNatural(natural)
  }, [shown, natural, onNatural])
  const frameProps = frameRef === undefined ? {} : { ref: frameRef }
  return (
    <div
      className={
        frameStyle === undefined
          ? styles.frame
          : [styles.frame, styles.frameZoomed].filter((name) => name !== undefined).join(' ')
      }
      style={frameStyle}
      hidden={!shown}
      data-pending={sized ? undefined : ''}
      {...frameProps}
    >
      {sized && title !== undefined && (
        <span className={styles.title} title={title} data-testid="image-viewer-title">
          {title}
        </span>
      )}
      <ViewedImage source={source} onSized={onSized} onNatural={onImageNatural} />
    </div>
  )
}

interface ViewedImageProps {
  readonly source: ImageViewerSource
  /** Called once what stands for the image has its size: the image, loaded, or the card that says it can't be. */
  readonly onSized: () => void
  /** Called with the image's natural size once it has loaded, or with null when it can't. */
  readonly onNatural: (size: Size | null) => void
}

/** An image at its own size or as large as fits; in its place, a card that says it can't be loaded. */
function ViewedImage({ source, onSized, onNatural }: ViewedImageProps): React.JSX.Element | null {
  switch (source.kind) {
    case ImageSourceKind.Pasted:
      return <PastedViewedImage source={source} onSized={onSized} onNatural={onNatural} />
    case ImageSourceKind.Workspace:
      return <WorkspaceViewedImage source={source} onSized={onSized} onNatural={onNatural} />
  }
}

/** In place of an image that can't be loaded: a card that says so. It has its size as it mounts. */
function MissingImage({ onSized }: { readonly onSized: () => void }): React.JSX.Element {
  const whenMounted = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) onSized()
    },
    [onSized],
  )
  return (
    <div ref={whenMounted} role="img" aria-label={MISSING_IMAGE_LABEL} className={styles.missing}>
      <Icon icon={faImage} size={IconSize.Large} />
      {MISSING_IMAGE_LABEL}
    </div>
  )
}

interface LoadedImageProps {
  /** Its data URL. */
  readonly url: string
  readonly alt: string
  readonly onSized: () => void
  readonly onNatural: (size: Size | null) => void
}

/**
 * An image's own element. It has its size once the browser has loaded its data URL: as it mounts for one the browser
 * still holds (shown before, or as a thumbnail), so it's sized in the commit that mounts it; on its `load` for any
 * other, a moment later. An `error` counts too: what the browser shows in its place has its size by then. Its natural
 * size is reported the same two ways, for the zoom of the frame it's in.
 */
function LoadedImage({ url, alt, onSized, onNatural }: LoadedImageProps): React.JSX.Element {
  const whenMounted = useCallback(
    (node: HTMLImageElement | null) => {
      if (node?.complete === true) {
        onSized()
        onNatural(naturalSizeOf(node))
      }
    },
    [onSized, onNatural],
  )
  const onLoaded = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>): void => {
      onSized()
      onNatural(naturalSizeOf(event.currentTarget))
    },
    [onSized, onNatural],
  )
  const onError = useCallback((): void => {
    onSized()
    onNatural(null)
  }, [onSized, onNatural])
  return <img ref={whenMounted} src={url} alt={alt} className={styles.image} onLoad={onLoaded} onError={onError} />
}

function PastedViewedImage({
  source,
  onSized,
  onNatural,
}: {
  readonly source: Extract<ImageViewerSource, { kind: ImageSourceKind.Pasted }>
  readonly onSized: () => void
  readonly onNatural: (size: Size | null) => void
}): React.JSX.Element | null {
  const state = useStoredImage(source.ref)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return null
    case StoredImageStatus.Missing:
      return <MissingImage onSized={onSized} />
    case StoredImageStatus.Loaded:
      return <LoadedImage url={state.url} alt={IMAGE_LABEL} onSized={onSized} onNatural={onNatural} />
  }
}

function WorkspaceViewedImage({
  source,
  onSized,
  onNatural,
}: {
  readonly source: Extract<ImageViewerSource, { kind: ImageSourceKind.Workspace }>
  readonly onSized: () => void
  readonly onNatural: (size: Size | null) => void
}): React.JSX.Element | null {
  const state = useWorkspaceImage(source.taskId, source.path)
  switch (state.status) {
    case StoredImageStatus.Loading:
      return null
    case StoredImageStatus.Missing:
      return <MissingImage onSized={onSized} />
    case StoredImageStatus.Loaded:
      return <LoadedImage url={state.url} alt={source.title} onSized={onSized} onNatural={onNatural} />
  }
}
