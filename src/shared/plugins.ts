/**
 * The plugins installed in Glade's plugins folder (`docs/plugin-api.md`), as Settings › Plugins lists them. Main finds
 * and validates them (`src/main/plugins`); the renderer only shows them.
 */

/** A plugin's `manifest.json`, validated. Unknown fields are dropped. */
export interface PluginManifest {
  /** Lowercase letters, digits and `-`; equal to the plugin's folder name. */
  readonly id: string
  /** Shown in the panel header and Settings. */
  readonly name: string
  /** The plugin's own version, semver. */
  readonly version: string
  /** The page to load: an `.html` file inside the plugin's folder, relative to it. */
  readonly entry: string
  /** An `.svg` or `.png` inside the plugin's folder, relative to it; null when it has none. */
  readonly icon: string | null
}

export enum PluginStatus {
  /** Its manifest is valid and its files are where it says: it can be turned on. */
  Valid = 'valid',
  /** Its manifest is missing or invalid, or names a file that isn't there or is outside its folder. It never loads. */
  Invalid = 'invalid',
}

/** A plugin whose manifest checks out. */
export interface ValidPlugin {
  readonly status: PluginStatus.Valid
  /** Its folder's name in the plugins folder, which is its manifest's `id`. */
  readonly folder: string
  readonly manifest: PluginManifest
  /** Its icon as a `data:` URL, for an `<img>`; null when it has none. */
  readonly iconUrl: string | null
  /** Whether it's turned on in Settings › Plugins. A plugin found for the first time is. */
  readonly enabled: boolean
}

/** A folder in the plugins folder that isn't a plugin Glade can load, and why. */
export interface InvalidPlugin {
  readonly status: PluginStatus.Invalid
  /** Its folder's name in the plugins folder. */
  readonly folder: string
  /** Why it can't load, e.g. `entry: index.html doesn't exist`. */
  readonly reason: string
}

/** One folder in the plugins folder. */
export type InstalledPlugin = ValidPlugin | InvalidPlugin

/** The plugins folder's name, in Glade's data folder (`docs/plugin-api.md`). */
export const PLUGINS_FOLDER_NAME = 'plugins'

/** The largest icon a plugin can have. It's sent to the window whole, so it's kept small. */
export const MAX_PLUGIN_ICON_BYTES = 256 * 1024

/** The largest `manifest.json` Glade reads. */
export const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024
