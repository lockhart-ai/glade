#!/usr/bin/env node
// Regenerates Settings → Models using the offline discovery and task-switching workflow.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const shots = mkdtempSync(join(tmpdir(), 'glade-settings-models-'))
try {
  const test = spawnSync(process.execPath, ['scripts/e2e.mjs', 'e2e/openrouter.spec.ts'], {
    cwd: ROOT,
    env: { ...process.env, GLADE_OPENROUTER_MEDIA_DIR: shots },
    stdio: 'inherit',
  })
  if (test.status !== 0) process.exitCode = 1
  else {
    for (const name of ['settings-models', 'openrouter-usage']) {
      const palette = spawnSync(
        createRequire(import.meta.url)('ffmpeg-static'),
        [
          '-y',
          '-loglevel',
          'error',
          '-i',
          join(shots, `${name}.png`),
          '-vf',
          'split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];[b][p]paletteuse=dither=none',
          join(ROOT, `docs/images/guide/${name}.png`),
        ],
        { cwd: ROOT, stdio: 'inherit' },
      )
      if (palette.status !== 0) process.exitCode = palette.status ?? 1
    }
  }
} finally {
  rmSync(shots, { recursive: true, force: true })
}
