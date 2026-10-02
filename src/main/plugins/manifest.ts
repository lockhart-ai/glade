import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  isPluginCapability,
  isPluginSettingType,
  MAX_PLUGIN_SETTING_OPTIONS,
  MAX_PLUGIN_SETTINGS,
  PluginSettingType,
  type PluginCapability,
  type PluginManifest,
  type PluginSetting,
} from '../../shared/plugins'

/** A plugin id: lowercase letters, digits and `-`, starting with a letter or digit, up to 64 characters. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Semver: `1.2.0`, with an optional pre-release and build (`1.2.0-beta.1+42`). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** The longest a plugin's name can be. */
export const MAX_PLUGIN_NAME = 40

/**
 * Whether `path` is relative and stays inside the folder it's relative to, as written: not absolute, and no `..` part.
 * A symlink can still take it out; discovery checks that on disk.
 */
export function isInsidePath(path: string): boolean {
  if (path === '' || isAbsolute(path) || path.startsWith('\\') || path.startsWith('~')) return false
  return path.split(/[/\\]/).every((part) => part !== '..')
}

/** A relative path inside the plugin's folder whose file name ends in one of `extensions`. */
function filePath(what: string, extensions: readonly string[]): z.ZodType<string> {
  const pattern = new RegExp(`\\.(${extensions.join('|')})$`, 'i')
  return z
    .string()
    .refine(isInsidePath, `Expected a path inside the plugin's folder`)
    .refine((path) => pattern.test(path), `Expected ${what}`)
}

/**
 * The capabilities a manifest asks for: each one this Glade knows, once, in the order listed. One it doesn't know (a
 * newer Glade's) is dropped rather than failing the plugin, as unknown fields are.
 */
export function knownCapabilities(listed: readonly string[]): PluginCapability[] {
  return [...new Set(listed.filter(isPluginCapability))]
}

/** A setting's key and an option's value: the characters a plugin id has. */
const settingName = z.string().regex(PLUGIN_ID, 'Expected lowercase letters, digits and -, up to 64 characters')

/** A setting's label and an option's: as short as a plugin's name. */
const settingLabel = z
  .string()
  .trim()
  .min(1, 'Expected a label that is not blank')
  .max(MAX_PLUGIN_NAME, `Expected at most ${String(MAX_PLUGIN_NAME)} characters`)

/** A `select` setting: a choice from a fixed list, whose default is one of its options. */
const selectSettingSchema = z
  .object({
    type: z.literal(PluginSettingType.Select),
    key: settingName,
    label: settingLabel,
    options: z
      .array(z.object({ value: settingName, label: settingLabel }), 'Expected a list of { value, label } options')
      .min(1, 'Expected at least one option')
      .max(MAX_PLUGIN_SETTING_OPTIONS, `Expected at most ${String(MAX_PLUGIN_SETTING_OPTIONS)} options`),
    default: z.string('Expected one of the option values'),
  })
  .superRefine((setting, context) => {
    const values = setting.options.map((option) => option.value)
    values.forEach((value, index) => {
      if (values.indexOf(value) !== index) {
        context.addIssue({ code: 'custom', path: ['options', index, 'value'], message: `Duplicate value ${value}` })
      }
    })
    if (!values.includes(setting.default)) {
      context.addIssue({ code: 'custom', path: ['default'], message: 'Expected one of the option values' })
    }
  })

/**
 * One entry of `settings`: every one has a `key` and a `type`. One of a type this Glade knows is checked in full; one
 * it doesn't (a newer Glade's) comes to null rather than failing the plugin, as an unknown capability does.
 */
const settingSchema = z
  .looseObject({ key: settingName, type: z.string('Expected a setting type, like "select"') })
  .transform((entry, context): ListedSetting => {
    if (!isPluginSettingType(entry.type)) return { key: entry.key, setting: null }
    const parsed = selectSettingSchema.safeParse(entry)
    if (parsed.success) return { key: entry.key, setting: parsed.data }
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    }
    return z.NEVER
  })

/** One entry of a manifest's `settings`: its key, and the setting when its type is one this Glade knows. */
interface ListedSetting {
  readonly key: string
  readonly setting: PluginSetting | null
}

/** A manifest's `settings`: a few entries, each key once (whatever its type), the ones this Glade knows kept. */
const settingsSchema = z
  .array(settingSchema, 'Expected a list of settings')
  .max(MAX_PLUGIN_SETTINGS, `Expected at most ${String(MAX_PLUGIN_SETTINGS)} settings`)
  .superRefine((listed, context) => {
    const keys = listed.map((entry) => entry.key)
    keys.forEach((key, index) => {
      if (keys.indexOf(key) !== index) {
        context.addIssue({ code: 'custom', path: [index, 'key'], message: `Duplicate key ${key}` })
      }
    })
  })
  .transform((listed) => listed.flatMap(({ setting }) => (setting === null ? [] : [setting])))

/** `manifest.json`, per `docs/plugin-api.md`. Unknown fields are ignored. */
export const pluginManifestSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID, 'Expected lowercase letters, digits and -, up to 64 characters'),
    name: z
      .string()
      .trim()
      .min(1, 'Expected a name that is not blank')
      .max(MAX_PLUGIN_NAME, `Expected at most ${String(MAX_PLUGIN_NAME)} characters`),
    version: z.string().regex(SEMVER, 'Expected a semver version, like 1.2.0'),
    entry: filePath('an .html file', ['html']),
    icon: filePath('an .svg or .png file', ['svg', 'png']).optional(),
    capabilities: z.array(z.string(), 'Expected a list of capability names, like ["machine"]').optional(),
    settings: settingsSchema.optional(),
  })
  .transform(({ id, name, version, entry, icon, capabilities, settings }): PluginManifest => ({
    id,
    name,
    version,
    entry,
    icon: icon ?? null,
    capabilities: knownCapabilities(capabilities ?? []),
    settings: settings ?? [],
  }))

/** What reading a manifest came to: the manifest, or why it isn't one. */
export type ManifestParse =
  { readonly ok: true; readonly manifest: PluginManifest } | { readonly ok: false; readonly reason: string }

/** Parses a `manifest.json`'s text into a manifest, or says why it isn't a valid one. */
export function parsePluginManifest(text: string): ManifestParse {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `manifest.json isn't valid JSON: ${(error as Error).message}` }
  }
  const parsed = pluginManifestSchema.safeParse(json)
  if (parsed.success) return { ok: true, manifest: parsed.data }
  const reason = parsed.error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? `manifest.json: ${issue.message}` : `${path}: ${issue.message}`
    })
    .join('; ')
  return { ok: false, reason }
}
