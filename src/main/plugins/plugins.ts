import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import {
  offersSetting,
  PluginStatus,
  settingValues,
  withGrant,
  withSetting,
  type InstalledPlugin,
  type PluginCapability,
} from '../../shared/plugins'
import { CommandFailure } from '../bridge/errors'
import type { Emit } from '../bridge/events'
import {
  getPluginGrants,
  getPluginSettings,
  getPluginStates,
  notePluginsFound,
  setPluginEnabled,
  setPluginGrant,
  setPluginSetting,
} from '../db/repositories/plugins'
import type { OpenPath } from '../files/files'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { findPlugins, type FoundPlugin, type FoundValidPlugin } from './discovery'

/** What the plugins need from the app. */
export interface PluginsContext {
  readonly db: Database
  readonly emit: Emit
  /** The plugins folder: `<userData>/plugins`. */
  readonly folder: string
  /** Opens the folder in Finder (Electron's `shell.openPath`). */
  readonly openPath: OpenPath
  /** Hears the plugins each time they're read or one is turned on or off, changed or not: the plugin views. */
  readonly onUpdate?: (plugins: readonly InstalledPlugin[]) => void
  /**
   * A rescan (`list`) found a plugin that was already known, changed on disk since (its manifest version or its
   * entry file's mtime and size), or one of a plugin's capabilities was turned on or off (`setCapability`): the plugin
   * views, which reload it if it's the one shown.
   */
  readonly onReload?: (ids: readonly string[]) => void
  readonly log?: Logger
}

/** The installed plugins, as Settings › Plugins lists and changes them. */
export interface Plugins {
  /**
   * Reads the plugins folder again, creating it if it's missing, and answers with what's in it. A plugin found for the
   * first time is turned on. Broadcasts `plugins.changed` when the list differs from the last time it was read. A
   * plugin found both times, but changed on disk since, is reloaded if it's the one shown (`onReload`).
   */
  list(): Promise<InstalledPlugin[]>
  /**
   * Turns a plugin on or off, and answers with the list as it now is. Broadcasts `plugins.changed`. Fails with
   * `not_found` for a plugin the folder didn't have a valid one for the last time it was read.
   */
  setEnabled(id: string, enabled: boolean): InstalledPlugin[]
  /**
   * Turns one of a plugin's capabilities on or off, and answers with the list as it now is. Broadcasts
   * `plugins.changed`, and reloads the plugin if it's the one shown (`onReload`), so its next snapshot has what it may
   * now see and nothing it no longer may. Fails with `not_found` for a plugin the folder didn't have a valid one for
   * the last time it was read, and `invalid_request` for a capability its manifest doesn't ask for.
   */
  setCapability(id: string, capability: PluginCapability, granted: boolean): InstalledPlugin[]
  /**
   * Sets one of the settings a plugin declares to one of the values it offers, saves it, and answers with the list as
   * it now is. Broadcasts `plugins.changed`; the plugin views (`onUpdate`) tell the plugin, if it's the one shown,
   * without reloading it. Fails with `not_found` for a plugin the folder didn't have a valid one for the last time it
   * was read, and `invalid_request` for a setting its manifest doesn't declare or a value that setting doesn't offer.
   */
  setSetting(id: string, key: string, value: string): InstalledPlugin[]
  /** Opens the plugins folder in Finder, creating it if it's missing. */
  openFolder(): Promise<void>
  /**
   * Reloads a plugin's view now, if it's the one shown (`onReload`); a no-op otherwise. Doesn't read the plugins
   * folder again. Fails with `not_found` for a plugin the folder didn't have a valid one for the last time it was
   * read.
   */
  reload(id: string): void
}

/**
 * What identifies a valid plugin's content, cheaply: its manifest's own version, and its entry file's mtime and size.
 * A plugin reinstalled with the same version but a rebuilt entry file (a different mtime or size) still counts as
 * changed; one merely re-copied with nothing different doesn't, unless the copy changed the entry file's mtime too.
 */
export async function pluginSignature(pluginsFolder: string, plugin: FoundValidPlugin): Promise<string | null> {
  try {
    const info = await stat(join(pluginsFolder, plugin.folder, plugin.manifest.entry))
    return `${plugin.manifest.version}:${String(info.mtimeMs)}:${String(info.size)}`
  } catch {
    // Removed or unreadable since discovery resolved it a moment ago: nothing to compare, so never "changed".
    return null
  }
}

export function createPlugins({
  db,
  emit,
  folder,
  openPath,
  onUpdate,
  onReload,
  log = SILENT_LOGGER,
}: PluginsContext): Plugins {
  let last: InstalledPlugin[] | null = null
  /** Each valid plugin's signature as of the last read, by folder: what the next read compares against. */
  let lastSignatures = new Map<string, string>()

  const withStates = (found: readonly FoundPlugin[]): InstalledPlugin[] => {
    const states = getPluginStates(db)
    const grants = getPluginGrants(db)
    const settings = getPluginSettings(db)
    return found.map((plugin) => {
      if (plugin.status !== PluginStatus.Valid) return plugin
      const granted = grants.get(plugin.folder)
      return {
        ...plugin,
        enabled: states.get(plugin.folder) ?? true,
        // Only what its manifest asks for now: a capability it dropped stays saved, but off, until it asks again.
        granted: plugin.manifest.capabilities.filter((capability) => granted?.has(capability) === true),
        // Only what its manifest declares now, each at the saved value if it still offers it, else its default.
        settings: settingValues(plugin.manifest.settings, settings.get(plugin.folder)),
      }
    })
  }

  const update = (plugins: InstalledPlugin[]): void => {
    const changed = last !== null && !isDeepStrictEqual(last, plugins)
    last = plugins
    onUpdate?.(plugins)
    if (changed) emit({ type: EventType.PluginsChanged, plugins })
  }

  const read = async (): Promise<FoundPlugin[]> => {
    try {
      return await findPlugins(folder)
    } catch (error) {
      log.error("the plugins folder can't be read", { folder, error })
      return []
    }
  }

  return {
    async list() {
      const found = await read()
      // The app quit while the folder was being read (the read at startup, say): there's nothing to save it to.
      if (!db.open) return []
      const valid = found.filter((plugin): plugin is FoundValidPlugin => plugin.status === PluginStatus.Valid)
      notePluginsFound(
        db,
        valid.map((plugin) => plugin.folder),
      )
      for (const plugin of found) {
        if (plugin.status === PluginStatus.Invalid) {
          log.warn('invalid plugin', { folder: plugin.folder, reason: plugin.reason })
        }
      }
      log.info('plugins found', { folder, valid: valid.length, invalid: found.length - valid.length })

      const signatures = new Map(
        await Promise.all(
          valid.map(async (plugin): Promise<[string, string | null]> => {
            const signature = await pluginSignature(folder, plugin)
            return [plugin.folder, signature]
          }),
        ),
      )
      const reloaded = valid
        .map((plugin) => plugin.folder)
        .filter((id) => {
          const previous = lastSignatures.get(id)
          const current = signatures.get(id)
          return previous !== undefined && current !== null && previous !== current
        })
      lastSignatures = new Map([...signatures].filter((entry): entry is [string, string] => entry[1] !== null))

      const plugins = withStates(found)
      update(plugins)
      if (reloaded.length > 0) onReload?.(reloaded)
      return plugins
    },
    setEnabled(id, enabled) {
      const plugin = last?.find((candidate) => candidate.folder === id)
      if (plugin?.status !== PluginStatus.Valid) throw new CommandFailure(BridgeErrorCode.NotFound, `No plugin ${id}`)
      setPluginEnabled(db, id, enabled)
      log.info(enabled ? 'plugin turned on' : 'plugin turned off', { id })
      const plugins = (last ?? []).map((candidate) =>
        candidate.folder === id && candidate.status === PluginStatus.Valid ? { ...candidate, enabled } : candidate,
      )
      update(plugins)
      return plugins
    },
    setCapability(id, capability, granted) {
      const plugin = last?.find((candidate) => candidate.folder === id)
      if (plugin?.status !== PluginStatus.Valid) throw new CommandFailure(BridgeErrorCode.NotFound, `No plugin ${id}`)
      if (!plugin.manifest.capabilities.includes(capability)) {
        throw new CommandFailure(BridgeErrorCode.InvalidRequest, `${id} doesn't ask for ${capability}`)
      }
      const before = plugin.granted.includes(capability)
      setPluginGrant(db, id, capability, granted)
      log.info(granted ? 'plugin capability turned on' : 'plugin capability turned off', { id, capability })
      const changed = withGrant(plugin, capability, granted)
      const plugins = (last ?? []).map((candidate) => (candidate.folder === id ? changed : candidate))
      update(plugins)
      if (before !== granted) onReload?.([id])
      return plugins
    },
    setSetting(id, key, value) {
      const plugin = last?.find((candidate) => candidate.folder === id)
      if (plugin?.status !== PluginStatus.Valid) throw new CommandFailure(BridgeErrorCode.NotFound, `No plugin ${id}`)
      if (!offersSetting(plugin, key, value)) {
        throw new CommandFailure(BridgeErrorCode.InvalidRequest, `${id} has no setting ${key} that offers ${value}`)
      }
      setPluginSetting(db, id, key, value)
      log.info('plugin setting changed', { id, key, value })
      const changed = withSetting(plugin, key, value)
      const plugins = (last ?? []).map((candidate) => (candidate.folder === id ? changed : candidate))
      update(plugins)
      return plugins
    },
    async openFolder() {
      await mkdir(folder, { recursive: true })
      const failure = await openPath(folder)
      if (failure !== '') throw new Error(`Couldn't open the plugins folder: ${failure}`)
    },
    reload(id) {
      const plugin = last?.find((candidate) => candidate.folder === id)
      if (plugin?.status !== PluginStatus.Valid) throw new CommandFailure(BridgeErrorCode.NotFound, `No plugin ${id}`)
      log.info('plugin reloaded', { id })
      onReload?.([id])
    },
  }
}
