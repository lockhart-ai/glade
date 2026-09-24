#!/usr/bin/env node
// Runs the e2e specs (e2e/*.spec.ts) against the built app, and optionally records them.
//
//   npm run test:e2e [-- <playwright test args>]
//   npm run record -- --out <dir> [<playwright test args>]
//
// Builds the app into out/testing first when it's stale (see scripts/test-build.mjs). With --out (`npm run record`),
// Playwright records each launch of the app over the DevTools protocol (no OS capture, no visible window) as
// <dir>/<spec>--<test>.webm, and this script converts each one to an .mp4 (for PRs) and a .gif, with ffmpeg-static.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { buildForTests, ROOT, testBuildIsStale } from './test-build.mjs'

// --record and --out <dir> are ours (`npm run record` passes --record); everything else goes to `playwright test`.
let args = process.argv.slice(2)
const record = args.includes('--record')
args = args.filter((arg) => arg !== '--record')
const outAt = args.indexOf('--out')
const out = outAt === -1 ? undefined : args[outAt + 1]
if (record !== (outAt !== -1) || (outAt !== -1 && (out === undefined || out.startsWith('-')))) {
  console.error('usage: npm run test:e2e [-- <playwright args>]')
  console.error('       npm run record -- --out <dir> [<playwright args>]')
  process.exit(2)
}
const recordDir = out === undefined ? undefined : resolve(out)
const playwrightArgs = outAt === -1 ? args : [...args.slice(0, outAt), ...args.slice(outAt + 2)]

if (testBuildIsStale()) {
  console.log('e2e: building the app into out/testing')
  if (!buildForTests()) {
    console.error('e2e: the build failed')
    process.exit(1)
  }
}

const env = { ...process.env }
if (recordDir !== undefined) {
  env.GLADE_RECORD_DIR = recordDir
  // Playwright writes its recordings with its own ffmpeg build, which it downloads once. (Without it, the app's page
  // never loads under recording.) Does nothing when it's already there.
  const install = spawnSync('npx', ['playwright', 'install', 'ffmpeg'], { cwd: ROOT, stdio: 'inherit' })
  if (install.status !== 0) {
    console.error("e2e: could not install Playwright's ffmpeg")
    process.exit(1)
  }
}
const run = spawnSync('npx', ['playwright', 'test', ...playwrightArgs], { cwd: ROOT, env, stdio: 'inherit' })
if (run.status !== 0 || recordDir === undefined) process.exit(run.status ?? 1)

// Convert each recording: an H.264 MP4 at full size, which GitHub plays inline, and a smaller GIF.
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
for (const file of readdirSync(recordDir).filter((name) => name.endsWith('.webm'))) {
  const webm = join(recordDir, file)
  const base = webm.slice(0, -'.webm'.length)
  const conversions = [
    ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', `${base}.mp4`],
    [
      '-vf',
      'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse',
      `${base}.gif`,
    ],
  ]
  for (const args of conversions) {
    const converted = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', webm, ...args], { stdio: 'inherit' })
    if (converted.status !== 0) {
      console.error(`e2e: could not convert ${webm}`)
      process.exit(1)
    }
  }
  console.log(`Recorded ${base}.{webm,mp4,gif}`)
}
