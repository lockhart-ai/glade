import { useCallback, useEffect, useRef } from 'react'
import type { PluginViewBounds } from '../../shared/bridge'
import { NATIVE_VIEW_SLOT_ATTRIBUTE } from '../../shared/ready'
import { useToast } from '../components'
import { useViewSlot, type PlaceView } from '../plugins/useViewSlot'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import styles from './LivePreview.module.css'

export interface LivePreviewProps {
  readonly taskId: string
  /** The tab's own URL: both what the page loads and the key it's placed, hidden and reloaded under. */
  readonly url: string
}

/**
 * A loopback dev server shown live (#764): main draws a sandboxed native view over `.slot`, the same way the HTML
 * preview does (`./HtmlPreview`, `../plugins/useViewSlot`), so it gives way to Glade's own overlays and goes on every
 * resize. Unlike the HTML preview, the page is loaded straight from its own URL, in a session that reaches only
 * loopback (`../../main/files/live-preview-network`): a request outside it is refused, and shown here as a quiet
 * notice naming the host that was refused. A click inside the page gives it the keyboard focus, handled entirely in
 * main (the view sits over this page, so nothing here could catch the click itself).
 */
export function LivePreview({ taskId, url }: LivePreviewProps): React.JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  const placeLivePreview = useGladeStore((state) => state.placeLivePreview)
  const clearLivePreviewBlocked = useGladeStore((state) => state.clearLivePreviewBlocked)
  const blockedHost = useGladeStore((state) => state.livePreviewBlocked[taskId]?.[url] ?? null)
  const toast = useToast()

  // Once, when this tab's preview mounts: an earlier block (this URL, shown before) doesn't linger into this showing.
  useEffect(() => {
    clearLivePreviewBlocked(taskId, url)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only on mount: `taskId`/`url` never change on one.
  }, [])

  const place = useCallback<PlaceView>(
    (bounds: PluginViewBounds | null) => {
      placeLivePreview(taskId, url, bounds).catch((error: unknown) => {
        toast.show({ message: describeFailure(error) })
      })
    },
    [taskId, url, placeLivePreview, toast],
  )
  useViewSlot(slot, true, place)

  return (
    <div className={styles.preview}>
      {blockedHost !== null && (
        <p className={styles.blocked} role="status">
          Some content was blocked: <span className={styles.host}>{blockedHost}</span> isn’t localhost.
        </p>
      )}
      <div
        ref={slot}
        className={styles.slot}
        data-testid="live-preview-slot"
        {...{ [NATIVE_VIEW_SLOT_ATTRIBUTE]: '' }}
      />
    </div>
  )
}
