import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { PluginManifest } from '../../shared/plugins'

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
  })
  .transform(({ id, name, version, entry, icon }): PluginManifest => ({ id, name, version, entry, icon: icon ?? null }))

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
