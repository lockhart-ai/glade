// Test helper: plugin views in memory, recording what the host does to them, so the host can be tested without Electron.
import type { PluginViewBounds } from '../../shared/bridge'
import type { GladeMessage } from '../../shared/plugin-api'
import { PluginInputKind } from './gesture'
import type { CreatePluginView, PluginView, PluginViewSpec } from './views'

/** A plugin view that records what's done to it, and lets a test post from its page or end it. */
export interface FakePluginView extends PluginView {
  readonly spec: PluginViewSpec
  /** Where it was last placed; null while it's hidden or before it's placed. */
  readonly bounds: PluginViewBounds | null
  /** Every message Glade sent its page, oldest first. */
  readonly sent: GladeMessage[]
  readonly destroyed: boolean
  /** How many times it gave the keyboard back to Glade's page. */
  readonly focusYielded: number
  /** Posts from its page, as `window.glade.post` would. */
  post(message: unknown): void
  /** A click in it: the mouse button goes down, then up, as the OS delivers it. */
  click(): void
  /** A key press in it, as the OS delivers it. */
  press(): void
  /** Ends its page, as a crash would. */
  crash(): void
}

export interface FakePluginViews {
  readonly create: CreatePluginView
  /** Every view made, oldest first. */
  readonly views: FakePluginView[]
  /** The last view made. Throws when there's none. */
  last(): FakePluginView
  /** Makes the next view fail to be made, as an unsafe one would. */
  refuseNext(): void
}

export function createFakePluginViews(): FakePluginViews {
  const views: FakePluginView[] = []
  let refuse = false
  return {
    views,
    create: (spec) => {
      if (refuse) {
        refuse = false
        return null
      }
      const view: FakePluginView = {
        spec,
        bounds: null,
        sent: [],
        destroyed: false,
        focusYielded: 0,
        place(bounds) {
          Object.assign(view, { bounds })
        },
        hide() {
          Object.assign(view, { bounds: null })
        },
        send(message) {
          view.sent.push(message)
        },
        yieldFocus() {
          Object.assign(view, { focusYielded: view.focusYielded + 1 })
        },
        destroy() {
          Object.assign(view, { destroyed: true, bounds: null })
        },
        post(message) {
          spec.onMessage(message)
        },
        click() {
          spec.onInput(PluginInputKind.Press)
          spec.onInput(PluginInputKind.Release)
        },
        press() {
          spec.onInput(PluginInputKind.Press)
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
      if (view === undefined) throw new Error('No plugin view was made')
      return view
    },
    refuseNext() {
      refuse = true
    },
  }
}
