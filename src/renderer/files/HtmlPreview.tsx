import { useCallback, useEffect, useRef } from 'react'
import type { PluginViewBounds } from '../../shared/bridge'
import { NATIVE_VIEW_SLOT_ATTRIBUTE } from '../../shared/ready'
import { useToast } from '../components'
import { useViewSlot, type PlaceView } from '../plugins/useViewSlot'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import styles from './HtmlPreview.module.css'

export interface HtmlPreviewProps {
  readonly taskId: string
  /** Relative to the workspace root. */
  readonly path: string
  /** How many times a read of the file has found it different from the read before: the preview reloads to match. */
  readonly version: number
}

/**
 * A static HTML file's preview (#614): main draws a sandboxed, offline native view over `.slot` (as a plugin's view
 * is drawn over its card's body, reusing `../plugins/useViewSlot` so it gives way to Glade's own overlays and goes
 * on every resize, and when the slot unmounts, the same way). It's isolated from Glade's page, the preload bridge,
 * Node and the network: nothing of the file's own folder but the file's own files loads, a link opens in the
 * browser instead of navigating the view, and anything the page asks for outside its folder is refused, with the
 * quiet notice below saying so. It follows the file: when `version` changes, the view reloads fresh from disk.
 */
export function HtmlPreview({ taskId, path, version }: HtmlPreviewProps): React.JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  // Whether this showing has placed the view over a real box yet (false once it has, till the next mount).
  const shownYet = useRef(true)
  const placeHtmlPreview = useGladeStore((state) => state.placeHtmlPreview)
  const clearHtmlPreviewBlocked = useGladeStore((state) => state.clearHtmlPreviewBlocked)
  const reloadHtmlPreview = useGladeStore((state) => state.reloadHtmlPreview)
  const blocked = useGladeStore((state) => state.htmlPreviewBlocked[taskId]?.[path] ?? false)
  const toast = useToast()

  // Once, when this file's preview mounts: an earlier block (this file, shown before) doesn't linger into this
  // showing of it.
  useEffect(() => {
    clearHtmlPreviewBlocked(taskId, path)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only on mount: `taskId`/`path` never change on one.
  }, [])

  const place = useCallback<PlaceView>(
    (bounds: PluginViewBounds | null) => {
      // This showing's first place over a real box: the view main holds may be this file's page from an earlier
      // showing, with the file since changed on disk while it was hidden, so `reopen` has main reload it fresh. A
      // later place (a resize, an overlay's giving way) only moves the view, so its page keeps its state.
      const reopen = shownYet.current && bounds !== null
      if (bounds !== null) shownYet.current = false
      placeHtmlPreview(taskId, path, bounds, reopen).catch((error: unknown) => {
        toast.show({ message: describeFailure(error) })
      })
    },
    [taskId, path, placeHtmlPreview, toast],
  )
  useViewSlot(slot, true, place)

  // The view it's placed already has the file's latest content (main reads it fresh each time): only a later change,
  // while it's still showing, needs its own reload.
  const lastReloaded = useRef(version)
  useEffect(() => {
    if (lastReloaded.current === version) return
    lastReloaded.current = version
    reloadHtmlPreview(taskId, path).catch((error: unknown) => {
      toast.show({ message: describeFailure(error) })
    })
  }, [version, taskId, path, reloadHtmlPreview, toast])

  return (
    <div className={styles.preview}>
      {blocked && (
        <p className={styles.blocked} role="status">
          Some content was blocked: this preview is offline.
        </p>
      )}
      <div
        ref={slot}
        className={styles.slot}
        data-testid="html-preview-slot"
        {...{ [NATIVE_VIEW_SLOT_ATTRIBUTE]: '' }}
      />
    </div>
  )
}
