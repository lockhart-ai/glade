// Regression test for "tasks.send failed: spawn ENOTDIR" in the packaged app: the SDK spawned Claude Code's binary at
// its path inside app.asar, which is a file, not a folder. Rebuilds that layout on disk and spawns for real.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { claudeCodeExecutable } from './sdk-backend'

const PACKAGE = join('node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64')

/** How a spawn ended: its exit code, or the error that stopped it starting. */
type SpawnResult = { kind: 'exited'; code: number | null } | { kind: 'failed'; code: string | undefined }

/** Spawns `path`. ENOTDIR is thrown synchronously, as it was in the app; other failures arrive as `error` events. */
function run(path: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      resolve({ kind: 'failed', code: error.code })
    }
    try {
      const child = spawn(path, [])
      child.on('error', failed)
      child.on('exit', (code) => {
        resolve({ kind: 'exited', code })
      })
    } catch (error) {
      failed(error as NodeJS.ErrnoException)
    }
  })
}

let resources: string

beforeEach(() => {
  // Glade.app/Contents/Resources: app.asar is a single archive file, and the unpacked binary sits beside it.
  resources = mkdtempSync(join(tmpdir(), 'glade-packaged-'))
  writeFileSync(join(resources, 'app.asar'), 'an asar archive')
  mkdirSync(join(resources, 'app.asar.unpacked', PACKAGE), { recursive: true })
  writeFileSync(join(resources, 'app.asar.unpacked', PACKAGE, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
})

afterEach(() => {
  rmSync(resources, { recursive: true, force: true })
})

it('spawns the packaged Claude Code binary from app.asar.unpacked, where the in-archive path fails with ENOTDIR', async () => {
  // Where the SDK resolves the binary in the packaged app.
  const inAsar = join(resources, 'app.asar', PACKAGE, 'claude')

  expect(await run(inAsar)).toEqual({ kind: 'failed', code: 'ENOTDIR' })

  const executable = claudeCodeExecutable(() => inAsar, 'darwin', 'arm64')

  expect(executable).toBe(join(resources, 'app.asar.unpacked', PACKAGE, 'claude'))
  expect(await run(executable ?? inAsar)).toEqual({ kind: 'exited', code: 0 })
})
