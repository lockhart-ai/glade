#!/usr/bin/env node
// Regenerates the user guide's picture of the menu bar popover, docs/images/guide/menu-bar.png:
//
//   node scripts/fixtures/menu-bar.mjs
//
// The popover is its own small window in the real app (360 CSS pixels wide, `MENU_BAR_POPOVER_WIDTH` in
// `src/shared/menuBar.ts`, as tall as its content), but a capture's window can't go below the main window's own
// minimum (1100x700, `WINDOW_MIN_SIZE` in `src/main/app.ts`), so this captures the `#menu-bar` route at that minimum,
// on menu-bar.json, then crops to the popover's own box: run through `ffmpeg`'s `cropdetect` first, against the
// page's near-black background, rather than a hard-coded box, so a content change that resizes the popover still
// crops right. Saved with a 256-colour palette, as the other guide pictures are.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SEED = join(HERE, 'menu-bar.json')
const OUT = join(ROOT, 'docs', 'images', 'guide', 'menu-bar.png')
// The main window's own minimum (`WINDOW_MIN_SIZE`): the smallest a capture can ask for, whatever the route.
const SIZE = '1100x700'
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`menu-bar: ${command} failed`)
    process.exit(1)
  }
}

/** The popover's own box in `file`, from ffmpeg's `cropdetect` against the page's near-black background. */
function detectCrop(file) {
  const result = spawnSync(ffmpeg, [
    ...['-loop', '1', '-t', '1', '-i', file],
    ...['-vf', 'cropdetect=24:2:0', '-f', 'null', '-'],
  ])
  const match = /crop=(\d+:\d+:\d+:\d+)/.exec(result.stderr.toString())
  if (match?.[1] === undefined) {
    console.error('menu-bar: ffmpeg cropdetect found no box')
    process.exit(1)
  }
  return match[1]
}

const shots = mkdtempSync(join(tmpdir(), 'glade-menu-bar-'))
try {
  run(process.execPath, [
    join(ROOT, 'scripts', 'screenshot.mjs'),
    ...['--out', shots, '--size', SIZE, '--name', 'menu-bar', '--seed', SEED, '--route', '#menu-bar'],
  ])
  const captured = join(shots, `menu-bar-${SIZE}.png`)
  const crop = detectCrop(captured)
  run(ffmpeg, [
    ...['-y', '-loglevel', 'error', '-i', captured],
    ...[
      '-vf',
      `crop=${crop},split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none`,
      OUT,
    ],
  ])
} finally {
  rmSync(shots, { recursive: true, force: true })
}
console.log(`Wrote ${OUT}`)
