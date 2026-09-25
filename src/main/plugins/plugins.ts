import { mkdir } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import { PluginStatus, type InstalledPlugin } from '../../shared/plugins'
import { CommandFailure } from '../bridge/errors'
import type { Emit } from '../bridge/events'
import { getPluginStates, notePluginsFound, setPluginEnabled } from '../db/repositories/plugins'
import type { OpenPath } from '../files/files'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { findPlugins, type FoundPlugin } from './discovery'

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
  readonly log?: Logger
}

/** The installed plugins, as Settings › Plugins lists and changes them. */
export interface Plugins {
  /**
   * Reads the plugins folder again, creating it if it's missing, and answers with what's in it. A plugin found for the
   * first time is turned on. Broadcasts `plugins.changed` when the list differs from the last time it was read.
   */
  list(): Promise<InstalledPlugin[]>
  /**
   * Turns a plugin on or off, and answers with the list as it now is. Broadcasts `plugins.changed`. Fails with
   * `not_found` for a plugin the folder didn't have a valid one for the last time it was read.
   */
  setEnabled(id: string, enabled: boolean): InstalledPlugin[]
  /** Opens the plugins folder in Finder, creating it if it's missing. */
  openFolder(): Promise<void>
}

export function createPlugins({ db, emit, folder, openPath, onUpdate, log = SILENT_LOGGER }: PluginsContext): Plugins {
  let last: InstalledPlugin[] | null = null

  const withStates = (found: readonly FoundPlugin[]): InstalledPlugin[] => {
    const states = getPluginStates(db)
    return found.map((plugin) =>
      plugin.status === PluginStatus.Valid ? { ...plugin, enabled: states.get(plugin.folder) ?? true } : plugin,
    )
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
      const valid = found.filter((plugin) => plugin.status === PluginStatus.Valid)
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
      const plugins = withStates(found)
      update(plugins)
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
    async openFolder() {
      await mkdir(folder, { recursive: true })
      const failure = await openPath(folder)
      if (failure !== '') throw new Error(`Couldn't open the plugins folder: ${failure}`)
    },
  }
}
