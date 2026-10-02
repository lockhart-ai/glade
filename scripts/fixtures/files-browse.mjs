#!/usr/bin/env node
// Regenerates the user guide's picture of the Browse tab, docs/images/guide/files-browse.png:
//
//   node scripts/fixtures/files-browse.mjs
//
// It makes the made-up Acme API workspace that files-browse.json reads its files from (in /tmp, outside any
// repository, so nothing in it is ignored), each file at a size worth showing; captures the app on that seed in a
// window that is never shown (scripts/screenshot.mjs), clicking the `tests` folder so a row is selected inside an open
// folder; and saves the capture with a 256-colour palette, as the guide's other pictures are, with ffmpeg-static.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SEED = join(HERE, 'files-browse.json')
const OUT = join(ROOT, 'docs', 'images', 'guide', 'files-browse.png')
// As files-browse.json has it.
const WORKSPACE = '/tmp/glade-guide/files-browse-workspace'
const SIZE = '1280x880'

/** The workspace's files, and each one's size in bytes. */
const FILES = {
  '.github/workflows/ci.yml': 640,
  'api/migrations/0001_initial.py': 1_900,
  'api/tests/test_burst_window_resets_after_a_sustained_rate_limit_for_anonymous_and_api_key_clients.py': 6_800,
  'api/tests/test_throttles.py': 4_200,
  'api/schema.sql': 18_300,
  'api/throttles.py': 3_600,
  'api/views.py': 12_900,
  'docs/rate-limits.md': 2_300,
  'web/public/logo.png': 1_400_000,
  'web/src/App.tsx': 5_100,
  'web/src/client.ts': 2_100,
  'web/src/theme.css': 9_700,
  'web/package.json': 1_200,
  'web/pnpm-lock.yaml': 212_000,
  '.gitignore': 348,
  'docker-compose.yml': 1_100,
  Dockerfile: 872,
  'pyproject.toml': 2_400,
  'README.md': 7_500,
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`files-browse: ${command} failed`)
    process.exit(1)
  }
}

rmSync(WORKSPACE, { recursive: true, force: true })
for (const [path, size] of Object.entries(FILES)) {
  const file = join(WORKSPACE, path)
  const line = `# Acme API sample: ${path}\n`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, line.repeat(Math.ceil(size / line.length)).slice(0, size))
}

const shots = mkdtempSync(join(tmpdir(), 'glade-files-browse-'))
try {
  run(process.execPath, [
    join(ROOT, 'scripts', 'screenshot.mjs'),
    ...['--out', shots, '--size', SIZE, '--name', 'files-browse', '--seed', SEED],
    ...['--click', '[role="treeitem"][aria-label="tests"]'],
  ])
  run(createRequire(import.meta.url)('ffmpeg-static'), [
    ...['-y', '-loglevel', 'error', '-i', join(shots, `files-browse-${SIZE}.png`)],
    ...['-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none', OUT],
  ])
} finally {
  rmSync(shots, { recursive: true, force: true })
  rmSync(WORKSPACE, { recursive: true, force: true })
}
console.log(`Wrote ${OUT}`)
