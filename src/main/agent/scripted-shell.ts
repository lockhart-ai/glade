/**
 * How a scripted session's `Shell` step runs its command (`./scripts`, `ScriptStepKind.Shell`): with `/bin/sh`, in a
 * folder, as Claude Code's `Bash` tool runs one. Only the test modes' scripted agent runs commands this way.
 */
import { execFile } from 'node:child_process'

/** How long a scripted command may run before it's stopped. */
export const SHELL_TIMEOUT_MS = 30_000

/**
 * What a scripted command's git reads of its setup: none of the machine's config (a user's signing key or hooks would
 * change what it does), and a made-up author.
 */
export const SHELL_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Acme Dev',
  GIT_AUTHOR_EMAIL: 'dev@acme.example',
  GIT_COMMITTER_NAME: 'Acme Dev',
  GIT_COMMITTER_EMAIL: 'dev@acme.example',
  GIT_TERMINAL_PROMPT: '0',
}

/** What a command came to: what it printed (its output, then its errors), and whether it failed. */
export interface ShellResult {
  readonly output: string
  readonly failed: boolean
}

/** Runs `command` with `/bin/sh` in `cwd`. Never throws: a command that can't run fails, saying why. */
export function runShell(command: string, cwd: string, timeoutMs: number = SHELL_TIMEOUT_MS): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, env: { ...process.env, ...SHELL_GIT_ENV }, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const printed = [stdout, stderr].filter((part) => part !== '').join('\n')
        resolve({ output: error !== null && printed === '' ? error.message : printed, failed: error !== null })
      },
    )
  })
}
