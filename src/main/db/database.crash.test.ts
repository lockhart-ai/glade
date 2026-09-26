import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openAppDatabase } from './database'
import { schemaVersion } from './migrate'
import { LATEST_SCHEMA_VERSION } from './migrations'

/** The Electron binary: in Node, the `electron` package exports its path. */
function electronBinary(): string {
  const path: unknown = createRequire(import.meta.url)('electron')
  if (typeof path !== 'string') throw new Error('expected the electron package to export its binary path')
  return path
}

/**
 * Runs the crash writer under Electron's own Node (`ELECTRON_RUN_AS_NODE`), so this also proves the installed
 * better-sqlite3 binary loads under Electron's ABI. Resolves once the writer is mid-transaction.
 */
function startWriterMidTransaction(file: string): Promise<ReturnType<typeof spawn>> {
  const writer = join(import.meta.dirname, 'test-fixtures', 'crash-writer.mjs')
  const child = spawn(electronBinary(), ['--expose-gc', writer, file], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.split('\n').includes('mid-transaction')) resolve(child)
    })
    child.on('exit', (code) => {
      reject(new Error(`crash writer exited early (${String(code)}): ${stderr}`))
    })
  })
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => {
    child.once('exit', (_code, signal) => {
      resolve(signal)
    })
  })
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'glade-crash-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

it('keeps the database consistent when the process is killed mid-write', async () => {
  const setup = openAppDatabase(dataDir)
  setup.db.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  setup.db.close()

  const child = await startWriterMidTransaction(setup.file)
  // The uncommitted transaction has already spilled pages to disk, so the kill lands mid-write.
  expect(statSync(`${setup.file}-wal`).size).toBeGreaterThan(1_000_000)
  const exited = waitForExit(child)
  child.kill('SIGKILL')
  expect(await exited).toBe('SIGKILL')

  const reopened = openAppDatabase(dataDir)
  try {
    expect(reopened.db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(reopened.db.prepare('SELECT body FROM note').pluck().all()).toEqual(['committed'])
    expect(schemaVersion(reopened.db)).toBe(LATEST_SCHEMA_VERSION)
    expect(reopened.migration.applied).toEqual([])
  } finally {
    reopened.db.close()
  }
}, 20_000)
