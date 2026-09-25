import { basename } from 'node:path'

/** The shell a terminal tab runs, and the environment it starts with. */
export interface TerminalShell {
  readonly file: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** The shell macOS gives a user who has none set. */
const DEFAULT_SHELL = '/bin/zsh'

/**
 * The environment a shell starts with: the app's own, less what only concerns Electron or Glade's test modes, with the
 * terminal it runs in named (`TERM`) and a UTF-8 locale when there's none (an app opened from Finder gets no `LANG`).
 */
export function shellEnv(
  base: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith('ELECTRON_') && !key.startsWith('GLADE_')) env[key] = value
  }
  if (!('LANG' in env)) env.LANG = 'en_US.UTF-8'
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Glade', ...extra }
}

/** Your login shell (`$SHELL -l`), as Terminal.app starts it, so it has your PATH and prompt. */
export function loginShell(env: NodeJS.ProcessEnv): TerminalShell {
  const file = env.SHELL === undefined || env.SHELL === '' ? DEFAULT_SHELL : env.SHELL
  return { file, args: ['-l'], env: shellEnv(env) }
}

/**
 * The shell a test mode runs (e2e, screenshots): bash with none of your profile or rc files, and a plain prompt of the
 * folder's name, so what a test sees doesn't depend on (or show) the machine it runs on.
 */
export function testShell(env: NodeJS.ProcessEnv): TerminalShell {
  return {
    file: '/bin/bash',
    args: ['--noprofile', '--norc'],
    env: shellEnv(env, { PS1: '\\W $ ', BASH_SILENCE_DEPRECATION_WARNING: '1', HISTFILE: '/dev/null' }),
  }
}

/** The name the shell's process goes by, which the terminal's foreground process has while the shell waits on you. */
export function shellName(shell: TerminalShell): string {
  return basename(shell.file)
}
