import { basename } from 'node:path'

/**
 * The foreground process group of a terminal, from `ps -o tpgid= -p <shell pid>`: a positive group id, or null when
 * there is none (`-1`, or nothing once the shell has gone).
 */
export function foregroundGroup(psOutput: string): number | null {
  const group = Number.parseInt(psOutput.trim(), 10)
  return Number.isSafeInteger(group) && group > 0 ? group : null
}

/**
 * The name of a terminal's foreground process, as node-pty's `process` reports it: its command's name, which a login
 * shell may give with a leading `-`, or, while the terminal has no foreground process, the path the shell was started
 * from.
 */
export function processName(foreground: string): string {
  return basename(foreground.replace(/^-/, ''))
}

/**
 * Whether a program other than the shell is running in the foreground of its terminal: the terminal's foreground
 * process is named otherwise than the shell.
 */
export function isRunningProgram(foreground: string, shell: string): boolean {
  const name = processName(foreground)
  return name !== '' && name !== shell
}
