import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runShell, SHELL_GIT_ENV } from './scripted-shell'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'glade-shell-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('runShell', () => {
  it('runs a command in a folder, and answers what it printed: its output, then its errors', async () => {
    expect(await runShell('pwd && echo oops >&2', dir)).toEqual({ output: `${dir}\n\noops\n`, failed: false })
    expect(await runShell('true', dir)).toEqual({ output: '', failed: false })
  })

  it('fails a command that exits non-zero, with what it printed, or why it couldn’t run', async () => {
    expect(await runShell('echo nope && exit 3', dir)).toEqual({ output: 'nope\n', failed: true })
    const missing = await runShell('ls', join(dir, 'nowhere'))
    expect(missing.failed).toBe(true)
    expect(missing.output).toMatch(/ENOENT|spawn/)
    expect((await runShell('sleep 5', dir, 50)).failed).toBe(true)
  })

  it('gives git a made-up author and none of the machine’s config', async () => {
    const { output } = await runShell('echo "$GIT_AUTHOR_NAME $GIT_CONFIG_GLOBAL"', dir)
    expect(output).toBe(`${SHELL_GIT_ENV.GIT_AUTHOR_NAME ?? ''} /dev/null\n`)
  })
})
