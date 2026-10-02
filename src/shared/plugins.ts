/**
 * The plugins installed in Glade's plugins folder (`docs/plugin-api.md`), as Settings › Plugins lists them. Main finds
 * and validates them (`src/main/plugins`); the renderer only shows them.
 */

/**
 * What a plugin can ask for beyond the task and agent events every plugin gets (`docs/plugin-api.md`, "Capabilities").
 * Each is off until you turn it on in Settings › Plugins.
 */
export enum PluginCapability {
  /** Readings of the Mac's load: CPU cores in use (all and Claude's), the GPU's utilisation, and Docker's containers. */
  Machine = 'machine',
}

const CAPABILITY_NAMES: ReadonlySet<string> = new Set(Object.values(PluginCapability))

/** Whether a name (from a manifest, or the database) is a capability this Glade knows. */
export function isPluginCapability(name: string): name is PluginCapability {
  return CAPABILITY_NAMES.has(name)
}

/** What Settings › Plugins says each capability lets a plugin do, beside its switch. */
export const PLUGIN_CAPABILITY_LABELS: Readonly<Record<PluginCapability, string>> = {
  [PluginCapability.Machine]: "Can see your Mac's CPU, GPU and Docker load",
}

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
  /** The capabilities it asks for, each once, in the order it lists them. Ones this Glade doesn't know are dropped. */
  readonly capabilities: readonly PluginCapability[]
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
  /** The capabilities it asks for that you've turned on in Settings › Plugins, in its manifest's order. None at first. */
  readonly granted: readonly PluginCapability[]
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

/** Whether a plugin may use a capability: it asks for it, and you've turned it on. */
export function isGranted(plugin: ValidPlugin, capability: PluginCapability): boolean {
  return plugin.granted.includes(capability)
}

/**
 * The plugin with a capability turned on or off: only ever one its manifest asks for, kept in its manifest's order. A
 * capability it doesn't ask for leaves it as it was.
 */
export function withGrant(plugin: ValidPlugin, capability: PluginCapability, granted: boolean): ValidPlugin {
  const next = new Set(plugin.granted)
  if (granted) next.add(capability)
  else next.delete(capability)
  return { ...plugin, granted: plugin.manifest.capabilities.filter((known) => next.has(known)) }
}

/**
 * The plugin the bottom bar shows beside the terminal: one at a time, the first enabled one by id; none when no valid
 * plugin is on.
 */
export function shownPlugin(plugins: readonly InstalledPlugin[]): ValidPlugin | null {
  const enabled = plugins.filter(
    (plugin): plugin is ValidPlugin => plugin.status === PluginStatus.Valid && plugin.enabled,
  )
  return enabled.sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0))[0] ?? null
}
