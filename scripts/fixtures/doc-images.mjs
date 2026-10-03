#!/usr/bin/env node
// Regenerates every image under docs/images/ from its recorded recipe, on current main:
//
//   node scripts/fixtures/doc-images.mjs [name…]
//
// With no names, it regenerates all 16 (see docs/doc-images.md for the list and what each shows). With one or more
// names (e.g. `node scripts/fixtures/doc-images.mjs hero control`), it regenerates only those. Each image is captured
// in a window that's never shown, from a seed in scripts/fixtures/ (`src/main/capture-seed.ts`), and saved with a
// 256-colour palette (ffmpeg-static), as the rest of the docs' screenshots are.
//
// Three images have their own script, since they need more than a seed and a size: `files-browse.mjs` (a made-up
// workspace of files, built under /tmp), `menu-bar.mjs` (the popover's own small window, cropped out of the capture's
// minimum size) and `nekomata.mjs` (the Nekomata plugin, built in its own repo: pass its folder as an extra argument,
// or set NEKOMATA_PLUGIN, or it's skipped with a message explaining why).
//
// Settings pages are reached by clicking the workspace switcher then Workspace settings… (nth-of-type(4) of its menu),
// since ⌘, can't be sent in capture mode (scripts/screenshot.mjs's header), then the wanted section in the nav
// (General is nth-of-type(1), Control nth-of-type(7); see src/renderer/settings/sections.ts's APP_SECTIONS order).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const IMAGES = join(ROOT, 'docs', 'images')
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')

const OPEN_SETTINGS = [
  '--click',
  'button[aria-label="Switch workspace"]',
  '--click',
  '[role="menu"] button:nth-of-type(4)',
]
const settingsSection = (nth) => ['--click', `nav[aria-label="Settings sections"] button:nth-of-type(${String(nth)})`]

/** One image captured straight from a seed and a size: `scripts/screenshot.mjs`'s own args, after `--out <dir>`. */
const SCREENSHOTS = {
  hero: { out: join(IMAGES, 'hero.png'), args: ['--seed', 'task-workspace.json', '--size', '1600x1000'] },
  subagents: { out: join(IMAGES, 'subagents.png'), args: ['--seed', 'subagents.json', '--size', '1600x1000'] },
  question: { out: join(IMAGES, 'question.png'), args: ['--seed', 'question.json', '--size', '1600x1100'] },
  permission: { out: join(IMAGES, 'permission.png'), args: ['--seed', 'permission-card.json', '--size', '1600x1000'] },
  control: {
    out: join(IMAGES, 'control.png'),
    args: ['--seed', 'settings-control.json', '--size', '1600x1000', ...OPEN_SETTINGS, ...settingsSection(7)],
  },
  window: { out: join(IMAGES, 'guide', 'window.png'), args: ['--seed', 'task-workspace.json', '--size', '1440x960'] },
  welcome: { out: join(IMAGES, 'guide', 'welcome.png'), args: ['--size', '1280x800'] },
  working: { out: join(IMAGES, 'guide', 'working.png'), args: ['--seed', 'agent-working.json', '--size', '1280x800'] },
  artifacts: { out: join(IMAGES, 'guide', 'artifacts.png'), args: ['--seed', 'artifacts.json', '--size', '1280x880'] },
  'permission-card': {
    out: join(IMAGES, 'guide', 'permission-card.png'),
    args: ['--seed', 'permission-card-bash.json', '--size', '1280x800'],
  },
  'settings-general': {
    out: join(IMAGES, 'guide', 'settings-general.png'),
    args: ['--seed', 'settings-general.json', '--size', '1280x800', ...OPEN_SETTINGS, ...settingsSection(1)],
  },
  'settings-control': {
    out: join(IMAGES, 'guide', 'settings-control.png'),
    args: ['--seed', 'settings-control.json', '--size', '1280x800', ...OPEN_SETTINGS, ...settingsSection(7)],
  },
  backfilled: {
    out: join(IMAGES, 'guide', 'backfilled.png'),
    args: ['--seed', 'backfilled.json', '--size', '1280x880'],
  },
}

/** The scripted images: their own recipe script, run with the extra arguments given to this one. */
const SCRIPTS = {
  'files-browse': { script: 'files-browse.mjs', needsPlugin: false },
  'menu-bar': { script: 'menu-bar.mjs', needsPlugin: false },
  nekomata: { script: 'nekomata.mjs', needsPlugin: true },
}

const NAMES = [...Object.keys(SCREENSHOTS), ...Object.keys(SCRIPTS)]

function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
}

/** Captures `spec`'s args into a temp dir, named `name`, then saves it palette-quantized at `spec.out`. */
function captureScreenshot(name, spec, extra) {
  const shots = mkdtempSync(join(tmpdir(), `glade-doc-images-${name}-`))
  try {
    const seedArgs = spec.args.map((arg) => (arg.endsWith('.json') ? join(HERE, arg) : arg))
    const result = run(process.execPath, [
      join(HERE, '..', 'screenshot.mjs'),
      ...['--out', shots, '--name', name, ...seedArgs, ...extra],
    ])
    if (result.status !== 0) return false
    const size = /--size (\d+x\d+)/.exec(spec.args.join(' '))?.[1] ?? '1600x1000'
    const captured = join(shots, `${name}-${size}.png`)
    const palette = run(ffmpeg, [
      ...['-y', '-loglevel', 'error', '-i', captured],
      ...[
        '-vf',
        'split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none',
        spec.out,
      ],
    ])
    return palette.status === 0
  } finally {
    rmSync(shots, { recursive: true, force: true })
  }
}

function runScript(name, spec, extraArgs) {
  if (spec.needsPlugin && extraArgs.length === 0 && process.env.NEKOMATA_PLUGIN === undefined) {
    console.log(
      `doc-images: skipping ${name} (nekomata.png): no built Nekomata plugin given. Pass its folder as an extra ` +
        'argument, or set NEKOMATA_PLUGIN, e.g.:\n' +
        '  node scripts/fixtures/doc-images.mjs nekomata -- <nekomata>/dist/glade/nekomata',
    )
    return true
  }
  const result = run(process.execPath, [join(HERE, spec.script), ...extraArgs])
  return result.status === 0
}

const args = process.argv.slice(2)
const splitAt = args.indexOf('--')
const names = (splitAt === -1 ? args : args.slice(0, splitAt)).filter((arg) => arg.length > 0)
const extraArgs = splitAt === -1 ? [] : args.slice(splitAt + 1)

for (const name of names) {
  if (!NAMES.includes(name)) {
    console.error(`doc-images: unknown image "${name}". Known: ${NAMES.join(', ')}`)
    process.exit(2)
  }
}

let ok = true
for (const name of names.length === 0 ? NAMES : names) {
  console.log(`doc-images: ${name}`)
  const succeeded =
    name in SCREENSHOTS ? captureScreenshot(name, SCREENSHOTS[name], []) : runScript(name, SCRIPTS[name], extraArgs)
  if (!succeeded) {
    console.error(`doc-images: ${name} failed`)
    ok = false
  }
}
process.exit(ok ? 0 : 1)
