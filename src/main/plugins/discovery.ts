import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { hasImageSignature, ImageMediaType } from '../../shared/images'
import {
  MAX_PLUGIN_ICON_BYTES,
  MAX_PLUGIN_MANIFEST_BYTES,
  PluginStatus,
  type InvalidPlugin,
  type PluginManifest,
} from '../../shared/plugins'
import { parsePluginManifest } from './manifest'

/** The file in a plugin's folder that describes it. */
export const MANIFEST_FILE = 'manifest.json'

/** A valid plugin as found on disk, before its enabled state is looked up. */
export interface FoundValidPlugin {
  readonly status: PluginStatus.Valid
  readonly folder: string
  readonly manifest: PluginManifest
  readonly iconUrl: string | null
}

/** One folder in the plugins folder, as found on disk. */
export type FoundPlugin = FoundValidPlugin | InvalidPlugin

/** Why a path in a plugin's folder can't be used. */
enum PathProblem {
  Missing = 'missing',
  Unreadable = 'unreadable',
  Outside = 'outside',
  NotAFile = 'not_a_file',
}

type Resolved =
  | { readonly ok: true; readonly path: string; readonly size: number }
  | { readonly ok: false; readonly problem: PathProblem; readonly code?: string }

/** Whether `path` is inside (not at) `root`. Both are real paths. */
function isInside(root: string, path: string): boolean {
  const inside = relative(root, path)
  return inside !== '' && !isAbsolute(inside) && inside.split(sep)[0] !== '..'
}

function errorCode(error: unknown): string | undefined {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' ? code : undefined
}

/** Resolves a path in a plugin's folder on disk, following symlinks: it must be a file, still inside the folder. */
async function resolveInside(root: string, path: string): Promise<Resolved> {
  let real: string
  try {
    real = await realpath(join(root, path))
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, problem: PathProblem.Missing }
    return { ok: false, problem: PathProblem.Unreadable, ...(code === undefined ? {} : { code }) }
  }
  if (!isInside(root, real)) return { ok: false, problem: PathProblem.Outside }
  const info = await stat(real)
  if (!info.isFile()) return { ok: false, problem: PathProblem.NotAFile }
  return { ok: true, path: real, size: info.size }
}

/** Says why a file a manifest field names can't be used, as `field: why`. */
function describeProblem(field: string, path: string, resolved: Extract<Resolved, { ok: false }>): string {
  switch (resolved.problem) {
    case PathProblem.Missing:
      return `${field}: ${path} doesn't exist`
    case PathProblem.Unreadable:
      return `${field}: ${path} can't be read (${resolved.code ?? 'unknown error'})`
    case PathProblem.Outside:
      return `${field}: ${path} is a symlink to outside the plugin's folder`
    case PathProblem.NotAFile:
      return `${field}: ${path} isn't a file`
  }
}

function invalid(folder: string, reason: string): InvalidPlugin {
  return { status: PluginStatus.Invalid, folder, reason }
}

/** The manifest's text, or why it can't be read. */
async function readManifest(root: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const resolved = await resolveInside(root, MANIFEST_FILE)
  if (!resolved.ok) {
    if (resolved.problem === PathProblem.Missing) return { ok: false, reason: `No ${MANIFEST_FILE}` }
    return { ok: false, reason: describeProblem(MANIFEST_FILE, MANIFEST_FILE, resolved) }
  }
  if (resolved.size > MAX_PLUGIN_MANIFEST_BYTES) {
    return { ok: false, reason: `${MANIFEST_FILE} is larger than ${String(MAX_PLUGIN_MANIFEST_BYTES / 1024)} KB` }
  }
  return { ok: true, text: await readFile(resolved.path, 'utf8') }
}

/** The icon as a `data:` URL, or why it can't be shown. */
async function readIcon(
  root: string,
  icon: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const resolved = await resolveInside(root, icon)
  if (!resolved.ok) return { ok: false, reason: describeProblem('icon', icon, resolved) }
  if (resolved.size > MAX_PLUGIN_ICON_BYTES) {
    return { ok: false, reason: `icon: ${icon} is larger than ${String(MAX_PLUGIN_ICON_BYTES / 1024)} KB` }
  }
  const bytes = await readFile(resolved.path)
  const png = extname(icon).toLowerCase() === '.png'
  if (png && !hasImageSignature(ImageMediaType.Png, bytes)) return { ok: false, reason: `icon: ${icon} isn't a PNG` }
  const type = png ? ImageMediaType.Png : 'image/svg+xml'
  return { ok: true, url: `data:${type};base64,${bytes.toString('base64')}` }
}

/** Reads one folder in the plugins folder: a plugin, or why it isn't one. */
async function readPlugin(dir: string, folder: string): Promise<FoundPlugin> {
  const root = await realpath(dir)
  const manifestText = await readManifest(root)
  if (!manifestText.ok) return invalid(folder, manifestText.reason)
  const parsed = parsePluginManifest(manifestText.text)
  if (!parsed.ok) return invalid(folder, parsed.reason)
  const { manifest } = parsed
  if (manifest.id !== folder) {
    return invalid(folder, `id: "${manifest.id}" doesn't match its folder's name, "${folder}"`)
  }
  const entry = await resolveInside(root, manifest.entry)
  if (!entry.ok) return invalid(folder, describeProblem('entry', manifest.entry, entry))
  let iconUrl: string | null = null
  if (manifest.icon !== null) {
    const icon = await readIcon(root, manifest.icon)
    if (!icon.ok) return invalid(folder, icon.reason)
    iconUrl = icon.url
  }
  return { status: PluginStatus.Valid, folder, manifest, iconUrl }
}

/** Whether `path` is a folder, following a symlink; false when it's anything else or nothing. */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Finds the plugins in `pluginsFolder` (`docs/plugin-api.md`), creating the folder when it's missing: each folder in it
 * is a plugin, valid or not, in order of folder name. Files, hidden entries (`.DS_Store`) and symlinks to nothing are
 * skipped. A folder that is a symlink counts, so a plugin can be worked on where it lives; the files its manifest
 * names must still be inside it.
 */
export async function findPlugins(pluginsFolder: string): Promise<FoundPlugin[]> {
  await mkdir(pluginsFolder, { recursive: true })
  const names = (await readdir(pluginsFolder)).filter((name) => !name.startsWith('.')).sort()
  const found = await Promise.all(
    names.map(async (name) => {
      const dir = join(pluginsFolder, name)
      if (!(await isFolder(dir))) return null
      try {
        return await readPlugin(dir, name)
      } catch (error) {
        // Removed while it was being read: it's gone. Unreadable: it's listed as such. Neither takes the rest down.
        if (!(await isFolder(dir))) return null
        return invalid(name, `It can't be read: ${(error as Error).message}`)
      }
    }),
  )
  return found.filter((plugin) => plugin !== null)
}
