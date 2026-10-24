// Test helper: the Files viewer's live preview view in memory, recording what the host does to it, so the host (and
// the handlers that drive it) can be tested without Electron.
import type { PluginViewBounds } from '../../shared/bridge'
import type { CreateLivePreviewView, LivePreviewView, LivePreviewViewSpec } from './live-preview-views'

/** A live preview view that records what's done to it, and lets a test block, connect or crash it. */
export interface FakeLivePreviewView extends LivePreviewView {
  readonly spec: LivePreviewViewSpec
  /** Where it was last placed; null while it's hidden or before it's placed. */
  readonly bounds: PluginViewBounds | null
  readonly destroyed: boolean
  /** How many times it was reloaded. */
  readonly reloaded: number
  /** As a blocked request would: tells the host, through `spec.onBlocked`, with the host it named. */
  block(host: string): void
  /** As the page finishing or failing to load would: tells the host, through `spec.onConnection`. */
  connect(connected: boolean): void
  /** Ends its page, as a crash would. */
  crash(): void
}

export interface FakeLivePreviewViews {
  readonly create: CreateLivePreviewView
  /** Every view made, oldest first. */
  readonly views: FakeLivePreviewView[]
  /** The last view made. Throws when there's none. */
  last(): FakeLivePreviewView
  /** Makes the next view fail to be made, as an unsafe one, or no window, would. */
  refuseNext(): void
}

export function createFakeLivePreviewViews(): FakeLivePreviewViews {
  const views: FakeLivePreviewView[] = []
  let refuse = false
  return {
    views,
    create: (spec) => {
      if (refuse) {
        refuse = false
        return null
      }
      const view: FakeLivePreviewView = {
        spec,
        bounds: null,
        destroyed: false,
        reloaded: 0,
        place(bounds) {
          Object.assign(view, { bounds })
        },
        hide() {
          Object.assign(view, { bounds: null })
        },
        reload() {
          Object.assign(view, { reloaded: view.reloaded + 1 })
        },
        destroy() {
          Object.assign(view, { destroyed: true, bounds: null })
        },
        block(host) {
          spec.onBlocked(host)
        },
        connect(connected) {
          spec.onConnection(connected)
        },
        crash() {
          spec.onGone()
        },
      }
      views.push(view)
      return view
    },
    last() {
      const view = views.at(-1)
      if (view === undefined) throw new Error('No live preview view was made')
      return view
    },
    refuseNext() {
      refuse = true
    },
  }
}
