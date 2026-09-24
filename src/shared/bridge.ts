/**
 * The typed API the preload script exposes to the renderer as `window.glade`.
 *
 * Empty for now: each feature adds its commands and events here, so the preload and renderer agree on one type.
 */
export type GladeBridge = Record<string, never>

/** The name the bridge is exposed under on `window`. */
export const BRIDGE_KEY = 'glade'
