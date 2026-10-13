// Test helper: the Files viewer's HTML preview view in memory, recording what the host does to it, so the host (and
// the handlers that drive it) can be tested without Electron.
import type { PluginViewBounds } from '../../shared/bridge'
import type { CreateHtmlPreviewView, HtmlPreviewView, HtmlPreviewViewSpec } from './html-preview-views'

/** A preview view that records what's done to it, and lets a test block, reload or crash it. */
export interface FakeHtmlPreviewView extends HtmlPreviewView {
  readonly spec: HtmlPreviewViewSpec
  /** Where it was last placed; null while it's hidden or before it's placed. */
  readonly bounds: PluginViewBounds | null
  readonly destroyed: boolean
  /** How many times it was reloaded. */
  readonly reloaded: number
  /** As a blocked request would: tells the host, through `spec.onBlocked`. */
  block(): void
  /** Ends its page, as a crash would. */
  crash(): void
}

export interface FakeHtmlPreviewViews {
  readonly create: CreateHtmlPreviewView
  /** Every view made, oldest first. */
  readonly views: FakeHtmlPreviewView[]
  /** The last view made. Throws when there's none. */
  last(): FakeHtmlPreviewView
  /** Makes the next view fail to be made, as an unsafe one, or no window, would. */
  refuseNext(): void
}

export function createFakeHtmlPreviewViews(): FakeHtmlPreviewViews {
  const views: FakeHtmlPreviewView[] = []
  let refuse = false
  return {
    views,
    create: (spec) => {
      if (refuse) {
        refuse = false
        return null
      }
      const view: FakeHtmlPreviewView = {
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
        block() {
          spec.onBlocked()
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
      if (view === undefined) throw new Error('No html preview view was made')
      return view
    },
    refuseNext() {
      refuse = true
    },
  }
}
