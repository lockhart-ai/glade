#!/usr/bin/env node
// Publishes screenshots and recordings to the orphan `screenshots` branch, for the supervisor.
//
//   node scripts/publish-media.mjs [--dry-run] <PR number> <folder>
//   node scripts/publish-media.mjs [--dry-run] --handback <name> <folder>
//
// Copies <folder>/*.{png,gif,mp4} to `pr-<N>/` (or `<name>/`) on the branch and pushes. With a PR number it then
// rewrites the PR body's Screenshots section (PNGs inline) and Recordings section (GIFs inline, each with its MP4 link)
// just before `Closes #`, replacing any existing ones and dropping a "Generated with Claude Code" footer.
//
// With --handback it touches no PR and prints the markdown for the phase's meta-issue comment instead, built from
// <folder>/index.txt (one `name<TAB>caption<TAB>done-when` line per recording, grouped by done-when) and the folder's
// `compare-*.png` files (app vs design). --dry-run prints what it would publish and the new body without pushing or
// editing anything. The branch is cached in the system temp dir. `gh` calls go through scripts/gh-team.mjs.
// Dependency-free (Node stdlib only).

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'lockhart-ai/glade'
const BRANCH = 'screenshots'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(tmpdir(), 'glade-screenshots-branch')

function fail(message) {
  process.stderr.write(`publish-media: ${message}\n`)
  process.exit(1)
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts })
const git = (...args) => run('git', ['-C', CACHE, ...args])
const ghTeam = (...args) => run('node', [join(ROOT, 'scripts', 'gh-team.mjs'), ...args], { cwd: ROOT })

// Arguments
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const rest = args.filter((a) => a !== '--dry-run')
let handback = null
if (rest[0] === '--handback') handback = rest.splice(0, 2)[1]
const [target, folderArg] = handback ? [handback, rest[0]] : rest
if (!target || !folderArg || rest.length > (handback ? 1 : 2)) {
  fail('usage: publish-media.mjs [--dry-run] <PR number> <folder> | [--dry-run] --handback <name> <folder>')
}
if (!handback && !/^\d+$/.test(target)) fail(`not a PR number: ${target}`)
if (handback && !/^[\w.-]+$/.test(handback)) fail(`not a plain folder name: ${handback}`)
const folder = resolve(folderArg)
if (!existsSync(folder)) fail(`no such folder: ${folder}`)

const dir = handback ?? `pr-${target}`
const base = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${dir}`
const url = (file) => `${base}/${encodeURIComponent(file)}`
const files = readdirSync(folder).sort()
const media = files.filter((f) => /\.(png|gif|mp4)$/.test(f))
const pngs = media.filter((f) => f.endsWith('.png'))
const gifs = media
  .filter((f) => f.endsWith('.gif'))
  .map((f) => f.slice(0, -4))
  .sort()
const hasMp4 = (name) => files.includes(`${name}.mp4`)
if (media.length === 0) fail(`no .png, .gif or .mp4 files in ${folder}`)

// Markdown for one recording: its GIF inline, then a link to its MP4 when there is one.
const recording = (name) => [
  `![${name}](${url(`${name}.gif`)})`,
  ...(hasMp4(name) ? [`[MP4](${url(`${name}.mp4`)})`] : []),
]

function prBody(original) {
  let body = original.replace(/\r\n/g, '\n')
  body = body.replace(/\n*(🤖 )?Generated with \[?Claude Code[\s\S]*$/, '')
  body = body.replace(/^(Screenshots|Recordings):[\s\S]*?(?=^(?:Screenshots|Recordings):|^Closes #|(?![\s\S]))/gm, '')
  body = body.trimEnd() + '\n\n'
  let sections = ''
  if (pngs.length) {
    sections += `Screenshots:\n\n${pngs.map((f) => `![${f.slice(0, -4)}](${url(f)})`).join('\n')}\n\n`
  }
  if (gifs.length) {
    sections += `Recordings:\n\n${gifs.map((g) => [`**${g}**`, ...recording(g)].join('\n\n')).join('\n\n')}\n\n`
  }
  const closes = body.lastIndexOf('Closes #')
  body = closes >= 0 ? body.slice(0, closes) + sections + body.slice(closes) : body + sections
  return body.trimEnd() + '\n'
}

function handbackMarkdown() {
  const indexPath = join(folder, 'index.txt')
  if (!existsSync(indexPath)) fail(`--handback needs ${indexPath}`)
  const groups = new Map()
  for (const line of readFileSync(indexPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())) {
    const [name, caption, doneWhen = ''] = line.split('\t')
    if (!gifs.includes(name)) fail(`index.txt lists ${name}, but there is no ${name}.gif`)
    groups.set(doneWhen, [...(groups.get(doneWhen) ?? []), { name, caption: caption || name }])
  }
  const unlisted = gifs.filter((g) => ![...groups.values()].flat().some((r) => r.name === g))
  if (unlisted.length) process.stderr.write(`publish-media: not in index.txt: ${unlisted.join(', ')}\n`)
  const out = ['## Workflows', '']
  for (const [doneWhen, recordings] of groups) {
    if (doneWhen) out.push(`### ${doneWhen}`, '')
    for (const r of recordings) out.push(`**${r.caption}**`, '', ...recording(r.name).flatMap((l) => [l, '']))
  }
  const compares = pngs.filter((f) => f.startsWith('compare-'))
  if (compares.length) {
    out.push('## App vs design', '')
    for (const f of compares) {
      const name = f.slice('compare-'.length, -4)
      out.push(`**${name}**`, '', `![${name}](${url(f)})`, '')
    }
  }
  return out.join('\n').trimEnd() + '\n'
}

// Build the new PR body (or handback comment) first, so a bad index.txt fails before anything is pushed.
const original = handback ? null : ghTeam('pr', 'view', target, '--json', 'body', '-q', '.body')
const text = handback ? handbackMarkdown() : prBody(original)

if (dryRun) {
  process.stdout.write(`Would publish ${media.length} files to ${BRANCH}:${dir}/ (${pngs.length} png, `)
  process.stdout.write(`${gifs.length} gif, ${media.filter((f) => f.endsWith('.mp4')).length} mp4):\n`)
  for (const f of media) process.stdout.write(`  ${f}\n`)
  process.stdout.write(handback ? '\nComment markdown:\n\n' : `\nWould set PR #${target}'s body to:\n\n`)
  process.stdout.write(text)
  process.exit(0)
}

// Publish to the branch.
if (existsSync(join(CACHE, '.git'))) {
  git('fetch', '-q', 'origin', BRANCH)
  git('reset', '-q', '--hard', `origin/${BRANCH}`)
} else {
  run('git', ['clone', '-q', '--single-branch', '-b', BRANCH, `https://github.com/${REPO}.git`, CACHE])
}
mkdirSync(join(CACHE, dir), { recursive: true })
for (const f of media) copyFileSync(join(folder, f), join(CACHE, dir, f))
git('add', dir)
if (git('status', '--porcelain', '--', dir).trim()) {
  git('commit', '-qm', handback ? `Add media for ${handback}` : `Add media for PR ${target}`)
  git('push', '-q', 'origin', BRANCH)
}

if (handback) {
  process.stdout.write(text)
} else {
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'publish-media-')), 'body.md')
  writeFileSync(bodyFile, text)
  ghTeam('pr', 'edit', target, '--body-file', bodyFile)
  process.stdout.write(`PR #${target}: ${pngs.length} png, ${gifs.length} gif published to ${BRANCH}:${dir}/\n`)
}
