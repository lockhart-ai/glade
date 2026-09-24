import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { Effort } from '../../../shared/domain'
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../../../shared/settings'
import { Row } from './rows'

/** How each setting's JSON value parses. A key missing here fails the typecheck. */
export const SETTING_SCHEMAS: { readonly [K in keyof Settings]: z.ZodType<Settings[K]> } = {
  defaultModel: z.string().min(1),
  defaultEffort: z.enum(Effort),
  statusSummary: z.boolean(),
  taskTitles: z.boolean(),
  notifications: z.boolean(),
  notificationSound: z.boolean(),
}

/** A stored value as its setting, or undefined when it isn't valid JSON of the right shape. */
function parseValue<K extends keyof Settings>(key: K, value: string): Settings[K] | undefined {
  let json: unknown
  try {
    json = JSON.parse(value)
  } catch {
    return undefined
  }
  const parsed = SETTING_SCHEMAS[key].safeParse(json)
  return parsed.success ? parsed.data : undefined
}

/**
 * The settings: each stored one, the rest at their defaults. A row with a key it doesn't know (a newer app version's)
 * or a value that doesn't parse is skipped, so its setting reads as its default.
 */
export function getSettings(db: Database): Settings {
  const stored = new Map<string, string>()
  for (const raw of db.prepare('SELECT key, value FROM settings').all()) {
    const row = new Row('settings', raw)
    stored.set(row.text('key'), row.text('value'))
  }
  const read = <K extends keyof Settings>(key: K): Settings[K] => {
    const value = stored.get(key)
    return (value === undefined ? undefined : parseValue(key, value)) ?? DEFAULT_SETTINGS[key]
  }
  return {
    defaultModel: read('defaultModel'),
    defaultEffort: read('defaultEffort'),
    statusSummary: read('statusSummary'),
    taskTitles: read('taskTitles'),
    notifications: read('notifications'),
    notificationSound: read('notificationSound'),
  }
}

/** Stores the settings in `patch`, replacing their earlier values, and returns the settings as they now are. */
export function updateSettings(db: Database, patch: SettingsPatch): Settings {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  )
  db.transaction(() => {
    // A key given as undefined (IPC can carry one) changes nothing, like a key left out.
    for (const [key, value] of Object.entries<unknown>(patch)) {
      if (value !== undefined) upsert.run(key, JSON.stringify(value))
    }
  })()
  return getSettings(db)
}
