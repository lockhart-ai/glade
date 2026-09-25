// The login shell environment resolver, run against real (fake) login shells: small `/bin/sh` scripts in a temp folder,
// never the machine's own shell or profile. Each is run as `<script> -ilc <probe>`, so `$2` is the probe's command.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  definedEnv,
  LOGIN_ENV_TIMEOUT_MS,
  LoginEnvSource,
  parseProbeOutput,
  probeCommand,
  resolveLoginEnv,
  type LoginEnvLog,
  type LoginEnvOptions,
} from './login-env'

/** launchd's PATH: what an app opened from Finder or the Dock starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

let folder: string
let log: { info: ReturnType<typeof vi.fn<LoginEnvLog['info']>>; warn: ReturnType<typeof vi.fn<LoginEnvLog['warn']>> }

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'glade-login-env-'))
  log = { info: vi.fn(), warn: vi.fn() }
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

/** Writes an executable `/bin/sh` script, standing in for a login shell and its profile. Returns its path. */
function fakeShell(body: string, name = 'login-shell'): string {
  const path = join(folder, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Resolves the environment with `shell`, from a launchd-style environment. */
function resolve(
  shell: string | undefined,
  options: Partial<LoginEnvOptions> = {},
): ReturnType<typeof resolveLoginEnv> {
  return resolveLoginEnv({
    shell,
    base: { PATH: LAUNCHD_PATH, HOME: '/Users/sample', LAUNCHD_ONLY: 'kept' },
    cwd: folder,
    log,
    ...options,
  })
}

describe('resolveLoginEnv', () => {
  it("reads the login shell's PATH, from launchd's bare one", async () => {
    const shell = fakeShell(`export PATH="/opt/sample/bin:$PATH"\nexec /bin/sh -c "$2"`)

    const resolved = await resolve(shell)

    expect(resolved.source).toBe(LoginEnvSource.Shell)
    expect(resolved.env.PATH).toBe(`/opt/sample/bin:${LAUNCHD_PATH}`)
    expect(log.info).toHaveBeenCalledExactlyOnceWith(`Agents run with the login shell's environment (${shell}).`)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it("keeps Glade's own variables the shell doesn't have, and takes the shell's over them", async () => {
    const shell = fakeShell(`export HOME=/Users/other EDITOR=vim\nexec /bin/sh -c "$2"`)

    const { env } = await resolve(shell)

    expect(env).toMatchObject({ HOME: '/Users/other', EDITOR: 'vim', LAUNCHD_ONLY: 'kept', PATH: LAUNCHD_PATH })
  })

  it("leaves out what the probe's shell set for itself", async () => {
    const shell = fakeShell(`exec /bin/sh -c "$2"`)

    const { env } = await resolve(shell)

    expect(env).not.toHaveProperty('_')
    expect(env).not.toHaveProperty('PWD')
    expect(env).not.toHaveProperty('OLDPWD')
    expect(env).not.toHaveProperty('SHLVL')
  })

  it('reads values holding newlines, equals signs, quotes and nothing at all', async () => {
    const shell = fakeShell(
      [
        `export MULTILINE='line one`,
        `line two'`,
        `export EQUATION='a=b==c' QUOTED="it's \\"quoted\\"" EMPTY='' UNICODE='café ✓'`,
        `exec /bin/sh -c "$2"`,
      ].join('\n'),
    )

    const { env } = await resolve(shell)

    expect(env).toMatchObject({
      MULTILINE: 'line one\nline two',
      EQUATION: 'a=b==c',
      QUOTED: `it's "quoted"`,
      EMPTY: '',
      UNICODE: 'café ✓',
    })
  })

  it('ignores whatever the profile prints before and after the environment, and on stderr', async () => {
    const shell = fakeShell(
      [
        `echo 'Last login: Mon Sep 21 09:12:44 on ttys001'`,
        `echo 'PATH=/not/this/one'`,
        `echo 'profile noise' >&2`,
        `export PATH="/opt/sample/bin:$PATH"`,
        `/bin/sh -c "$2"`,
        `echo 'PATH=/nor/this/one'`,
        `echo 'Saving session...'`,
      ].join('\n'),
    )

    const resolved = await resolve(shell)

    expect(resolved.source).toBe(LoginEnvSource.Shell)
    expect(resolved.env.PATH).toBe(`/opt/sample/bin:${LAUNCHD_PATH}`)
  })

  it('takes the environment of a shell that printed it and then exited with an error', async () => {
    const shell = fakeShell(`export PATH="/opt/sample/bin:$PATH"\n/bin/sh -c "$2"\nexit 3`)

    const resolved = await resolve(shell)

    expect(resolved.source).toBe(LoginEnvSource.Shell)
    expect(resolved.env.PATH).toBe(`/opt/sample/bin:${LAUNCHD_PATH}`)
  })

  it("doesn't wait for the shell to end once it has printed the environment", async () => {
    // The profile leaves something running that holds the output open.
    const shell = fakeShell(`export PATH="/opt/sample/bin:$PATH"\n/bin/sh -c "$2"\nexec sleep 30`)

    const resolved = await resolve(shell, { timeoutMs: 5000 })

    expect(resolved.source).toBe(LoginEnvSource.Shell)
  })

  describe("falls back to Glade's own environment, and logs why", () => {
    /** Checks it fell back, for `reason`, to the launchd environment. */
    async function expectFallback(resolving: ReturnType<typeof resolveLoginEnv>, reason: RegExp): Promise<void> {
      const resolved = await resolving
      expect(resolved).toEqual({
        source: LoginEnvSource.Fallback,
        env: { PATH: LAUNCHD_PATH, HOME: '/Users/sample', LAUNCHD_ONLY: 'kept' },
        reason: expect.stringMatching(reason) as unknown,
      })
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^Couldn't read the login shell's environment \(.+\); agents run with Glade's own\.$/),
      )
      expect(log.warn.mock.calls[0]?.[0]).toContain(resolved.source === LoginEnvSource.Fallback ? resolved.reason : '')
      expect(log.info).not.toHaveBeenCalled()
    }

    it('when the shell hangs, after the timeout, killing it and what it was running', async () => {
      const pids = join(folder, 'pids')
      const shell = fakeShell(`sleep 30 &\necho "$$ $!" > '${pids}'\nwait`)
      const started = Date.now()

      await expectFallback(resolve(shell, { timeoutMs: 200 }), /^it took longer than 200 ms$/)

      expect(Date.now() - started).toBeLessThan(1000)
      const [shellPid, sleepPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number)
      for (const pid of [shellPid, sleepPid]) {
        // Signal 0 only checks the process is there.
        await vi.waitFor(() => {
          expect(() => process.kill(pid ?? 0, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        })
      }
    })

    it('when the profile hangs holding the output open in a process group of its own, after the timeout', async () => {
      // `set -m` puts the background job in its own group, which outlives the shell and keeps its output open.
      const shell = fakeShell(`set -m\nsleep 2 &\nexit 0`)

      await expectFallback(resolve(shell, { timeoutMs: 300 }), /^it took longer than 300 ms$/)
    })

    it('when the shell exits with an error without printing it', async () => {
      const shell = fakeShell(`echo 'zsh: parse error near \`fi'"'"'' >&2\nexit 1`)

      await expectFallback(resolve(shell), /^it exited with code 1 without printing its environment$/)
    })

    it('when the shell exits cleanly without printing it', async () => {
      await expectFallback(resolve(fakeShell('exit 0')), /^it exited with code 0 without printing its environment$/)
    })

    it('when the shell is killed', async () => {
      await expectFallback(resolve(fakeShell('kill -TERM $$')), /^it was killed by SIGTERM without printing/)
    })

    it('when the shell prints only part of it', async () => {
      const shell = fakeShell(`/bin/sh -c "$2" | head -c 40\nexit 0`)

      await expectFallback(resolve(shell), /^it exited with code 0 without printing its environment$/)
    })

    it("when $SHELL names a shell that doesn't exist", async () => {
      await expectFallback(resolve(join(folder, 'no-such-shell')), /ENOENT/)
    })

    it("when $SHELL names a file that isn't executable", async () => {
      const shell = join(folder, 'not-executable')
      writeFileSync(shell, '#!/bin/sh\n')

      await expectFallback(resolve(shell), /EACCES/)
    })

    it('when $SHELL is not set, or empty', async () => {
      await expectFallback(resolve(undefined), /^\$SHELL is not set$/)
      log.warn.mockClear()
      await expectFallback(resolve(''), /^\$SHELL is not set$/)
    })
  })

  it('gives the shell ten seconds, and logs to the console by default', async () => {
    expect(LOGIN_ENV_TIMEOUT_MS).toBe(10_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await resolveLoginEnv({ shell: undefined, base: {}, cwd: folder })

    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('runs the shell in the folder given, as a login shell, with its own environment', async () => {
    const args = join(folder, 'args')
    const shell = fakeShell(`printf '%s|%s|%s' "$1" "$(pwd -P)" "$LAUNCHD_ONLY" > '${args}'\nexec /bin/sh -c "$2"`)

    await resolve(shell)

    expect(readFileSync(args, 'utf8')).toBe(`-ilc|${realpathSync(folder)}|kept`)
  })
})

describe('parseProbeOutput', () => {
  const MARKER = '__GLADE_ENV_sample__'

  it('reads the NUL-separated variables between the markers', () => {
    expect(parseProbeOutput(`junk${MARKER}A=1\0B=two\nlines\0C=x=y\0${MARKER}more junk`, MARKER)).toEqual({
      A: '1',
      B: 'two\nlines',
      C: 'x=y',
    })
  })

  it('is null until both markers are out, since the output may come in pieces', () => {
    expect(parseProbeOutput('Last login: today', MARKER)).toBe(null)
    expect(parseProbeOutput(`${MARKER}A=1\0`, MARKER)).toBe(null)
  })

  it('skips entries with no name', () => {
    expect(parseProbeOutput(`${MARKER}=nameless\0\0A=1\0${MARKER}`, MARKER)).toEqual({ A: '1' })
  })
})

describe('probeCommand', () => {
  it('prints the environment NUL-separated between two markers, quoting them for the shell', () => {
    expect(probeCommand("it's")).toBe(`printf '%s' 'it'\\''s'; /usr/bin/env -0; printf '%s' 'it'\\''s'`)
  })
})

describe('definedEnv', () => {
  it('keeps the variables that are set', () => {
    expect(definedEnv({ A: '1', B: undefined, C: '' })).toEqual({ A: '1', C: '' })
  })
})
