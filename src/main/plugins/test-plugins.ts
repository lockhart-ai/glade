// Test helpers: made-up plugins written into a temporary plugins folder.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A plugins folder for the tests that never read one (the bridge wants a folder all the same). Nothing is created
 * there unless something reads it.
 */
export const UNREAD_PLUGINS_FOLDER = join(tmpdir(), 'glade-test-plugins-never-read')

/** A made-up PNG: its signature, then some bytes. */
export const SAMPLE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

/** A made-up SVG icon. */
export const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>'

/** A made-up plugin's manifest, valid for a folder named `id`. */
export function sampleManifest(id = 'pomodoro'): Record<string, unknown> {
  return { id, name: 'Pomodoro', version: '0.4.2', entry: 'index.html', icon: 'icon.svg' }
}

/** A new, empty temporary folder to hold plugins folders. */
export function tempPluginsParent(): string {
  return mkdtempSync(join(tmpdir(), 'glade-plugins-'))
}

/** What a plugin's folder holds, by path relative to it: text or bytes. */
export type PluginFiles = Readonly<Record<string, string | Buffer>>

/**
 * Writes a plugin folder `folder` into `pluginsFolder`: `manifest` as its `manifest.json` (JSON-encoded unless it's
 * already a string; none when null), and `files`, by default the `index.html` and `icon.svg` the sample manifest
 * names. Answers with the plugin's folder.
 */
export function writePlugin(
  pluginsFolder: string,
  folder: string,
  manifest: Record<string, unknown> | string | null = sampleManifest(folder),
  files: PluginFiles = { 'index.html': '<!doctype html><title>Pomodoro</title>', 'icon.svg': SAMPLE_SVG },
): string {
  const dir = join(pluginsFolder, folder)
  mkdirSync(dir, { recursive: true })
  if (manifest !== null) {
    writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}
