#!/usr/bin/env node
// Regenerates the README's picture of Nekomata beside the terminal, docs/images/nekomata.png:
//
//   node scripts/fixtures/nekomata.mjs <path to the built Nekomata plugin>
//   NEKOMATA_PLUGIN=<nekomata>/dist/glade/nekomata node scripts/fixtures/nekomata.mjs
//
// Nekomata is built in its own repo (github.com/lockhart-ai/nekomata), so this needs its built Glade plugin folder,
// named either as the first argument or in NEKOMATA_PLUGIN (as e2e/nekomata.spec.ts takes it): `./build.sh glade`
// there, then one of the above with `<nekomata>/dist/glade/nekomata`.
//
// It copies that folder into a parent folder of its own (`--plugins` copies every plugin folder inside the one it's
// given, named `nekomata` as the plugins folder expects), seeds the sample task nekomata.json describes (an open
// question, so the cat raises its paw, and two subagents, so it has kittens), captures the app with the plugin showing
// beside the terminal, and saves it with a 256-colour palette, as the other README images are.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SEED = join(HERE, 'nekomata.json')
const OUT = join(ROOT, 'docs', 'images', 'nekomata.png')
const SIZE = '1600x1000'

// Nekomata's bundled page (its whole cat cafe, canvas included) is much bigger than the sample plugins, so it's still
// loading when a single capture would ask for its page: the first shot never shows it (nothing pastes in), and the
// app then quits mid-load, logging a load failure that's really just that race.
//
// A capture's `settle()` (src/main/capture-views.ts) waits for the plugin's fonts, not for a frame it's actually
// drawn: a view in a window that's never shown gets none on its own (`capturePage()` draws the one it captures), so
// Nekomata's canvas — sized and redrawn from a `resize` its own page gets once Glade places it at its slot's real
// size, not from the window's — can still be blank the moment that capture is taken, even once its DOM (the
// overlay's speech bubbles and labels) is there. Asking for more shots than sizes, repeating the real size, settles
// the view again each time (each one re-sends its size and re-waits), giving its own redraw the real time between
// them to finish before the last shot, the one this script keeps.
const WARMUP_SIZE = '1100x700'

const plugin = process.argv[2] ?? process.env.NEKOMATA_PLUGIN

function fail(message) {
  console.error(`nekomata: ${message}`)
  console.error(
    'usage: node scripts/fixtures/nekomata.mjs <built nekomata plugin folder> (or NEKOMATA_PLUGIN=<folder>)',
  )
  process.exit(2)
}

if (plugin === undefined) fail('no built Nekomata plugin given')
if (!existsSync(join(plugin, 'manifest.json'))) fail(`${plugin} has no manifest.json: is it the built plugin folder?`)

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`nekomata: ${command} failed`)
    process.exit(1)
  }
}

const plugins = mkdtempSync(join(tmpdir(), 'glade-nekomata-plugins-'))
const shots = mkdtempSync(join(tmpdir(), 'glade-nekomata-'))
try {
  cpSync(plugin, join(plugins, 'nekomata'), { recursive: true })
  run(process.execPath, [
    join(ROOT, 'scripts', 'screenshot.mjs'),
    ...['--out', shots, '--size', WARMUP_SIZE, '--size', SIZE, '--size', SIZE, '--name', 'nekomata', '--seed', SEED],
    ...['--plugins', plugins],
  ])
  run(createRequire(import.meta.url)('ffmpeg-static'), [
    ...['-y', '-loglevel', 'error', '-i', join(shots, `nekomata-${SIZE}.png`)],
    ...['-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none', OUT],
  ])
} finally {
  rmSync(plugins, { recursive: true, force: true })
  rmSync(shots, { recursive: true, force: true })
}
console.log(`Wrote ${OUT}`)
