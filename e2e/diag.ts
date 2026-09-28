// TEMPORARY diagnostics for #375, reverted before review: the per-workspace terminal spec, checking after every step
// that main and the window still answer, and dumping what they're doing (sample, ps, the app's log) when one doesn't.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Glade } from './fixtures'

const DIAG = '/tmp/glade-diag'

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

export async function alive(glade: Glade, label: string): Promise<void> {
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
