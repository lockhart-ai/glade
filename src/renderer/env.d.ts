import type { GladeBridge } from '../shared/bridge'

declare global {
  interface Window {
    readonly glade: GladeBridge
  }
}
