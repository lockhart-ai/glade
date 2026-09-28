// TEMPORARY diagnostics for #375, reverted before review: the per-workspace terminal spec, checking after every step
// that main and the window still answer, and dumping what they're doing (sample, ps, the app's log) when one doesn't.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { chooseFolder, expect, openWorkspace, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { regions, terminal } from './selectors'

const DIAG = '/tmp/glade-diag'

async function run(window: Page, line: string): Promise<void> {
  await terminal(window).screen.click()
  await window.keyboard.type(line)
  await window.keyboard.press('Enter')
}

function line(window: Page, text: string) {
  return terminal(window).rows.filter({ hasText: new RegExp(`^${text.replace(/[$.]/g, '\\$&')}\\s*$`) })
}

function within<T>(promise: Promise<T>, ms: number): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'ok',
      (error: unknown) => `error ${String(error)}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('HUNG'), ms)),
  ])
}

function shell(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    return `(${file} failed: ${String(error)})`
  }
}

async function alive(glade: Glade, label: string): Promise<void> {
  const started = Date.now()
  const [main, page] = await Promise.all([
    within(
      glade.app.evaluate(() => 1),
      8_000,
    ),
    within(
      glade.window.evaluate(() => 1),
      8_000,
    ),
  ])
  const ms = Date.now() - started
  mkdirSync(DIAG, { recursive: true })
  appendFileSync(join(DIAG, 'steps.txt'), `${label}: main=${main} page=${page} ${String(ms)}ms\n`)
  if (main === 'ok' && page === 'ok') return
  const pid = String(glade.app.process().pid)
  const out = join(DIAG, `hang-${pid}-${String(Date.now())}.txt`)
  const children = shell('pgrep', ['-P', pid])
    .trim()
    .split('\n')
    .filter((child) => child !== '')
  const parts = [
    `step ${label}: main=${main} page=${page}`,
    `== ps`,
    shell('ps', ['-o', 'pid,ppid,stat,%cpu,time,command', '-p', [pid, ...children].join(',')]),
    `== sample main ${pid}`,
    shell('sample', [pid, '3']),
  ]
  for (const child of children) parts.push(`== sample child ${child}`, shell('sample', [child, '2']))
  parts.push(
    '== main.log tail',
    existsSync(glade.logFile) ? readFileSync(glade.logFile, 'utf8').split('\n').slice(-150).join('\n') : '(no log)',
  )
  writeFileSync(out, parts.join('\n'))
  throw new Error(`diag: ${label}: main=${main} page=${page}, see ${out}`)
}

test('diag: each workspace has its own tabs, and switching keeps the others’ shells running', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const api = join(parent, 'acme-api')
  const web = join(parent, 'acme-web')
  mkdirSync(api)
  mkdirSync(web)
  const glade = await launch({ chosenFolder: api })
  const { window } = glade
  await openWorkspace(window)
  const term = terminal(window)
  const workspace = regions(window).workspace
  await alive(glade, 'opened')

  await term.newTab.click()
  await expect(line(window, 'acme-api $')).toHaveCount(1)
  await run(window, 'echo api-first')
  await window.keyboard.press('Meta+KeyT')
  await expect(term.tabs).toHaveText(['bash', 'bash'])
  await expect(line(window, 'acme-api $')).toHaveCount(1)
  await term.tabs.nth(0).click()
  await expect(line(window, 'api-first')).toHaveCount(1)
  await alive(glade, 'api tabs')

  await chooseFolder(glade, web)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('acme-web')
  await expect(term.tabs).toHaveCount(0)
  await alive(glade, 'web shown')
  await term.newTab.click()
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, 'acme-web $')).toHaveCount(1)
  await alive(glade, 'web tab')
  const go = join(parent, 'go')
  const printed = join(parent, 'printed')
  await run(window, `while [ ! -e ${go} ]; do sleep 0.1; done; echo web-while-hidden; touch ${printed}`)
  await alive(glade, 'web loop typed')

  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await alive(glade, 'api chosen')
  await expect(workspace).toContainText('acme-api')
  await expect(term.tabs).toHaveText(['bash', 'bash'])
  await expect(term.tabs.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(line(window, 'api-first')).toHaveCount(1)
  await alive(glade, 'api shown')
  writeFileSync(go, '')
  await expect.poll(() => existsSync(printed)).toBe(true)
  await alive(glade, 'printed')

  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-web')
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, 'web-while-hidden')).toHaveCount(1)
  await alive(glade, 'web back')
  await run(window, 'echo web-still-here')
  await expect(line(window, 'web-still-here')).toHaveCount(1)
  await alive(glade, 'done')
})
