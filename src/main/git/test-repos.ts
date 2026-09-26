// Test helpers: real git repositories in a temporary folder, made and changed as an agent's commands would, with none of
// the machine's git config (SHELL_GIT_ENV), so the tests run the same anywhere.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SHELL_GIT_ENV } from '../agent/scripted-shell'
import { execGit } from './git'

/** Git as Glade runs it, but reading none of the machine's config. */
export const TEST_GIT_RUN = execGit({ ...process.env, ...SHELL_GIT_ENV })

export interface TestRepos {
  /** The temporary folder, real (on macOS, `/private/var/…`, as git reports it). */
  readonly root: string
  /** Runs a shell command in a folder (the root by default), as an agent's `Bash` call would; answers what it printed. */
  sh(command: string, cwd?: string): string
  /** Makes a repository at `path` (from the root) on `main`, with `files` as its first commit. Answers its path. */
  repo(path: string, files?: Readonly<Record<string, string>>): string
  /** Writes a file, making its folders. */
  write(path: string, text: string | Buffer): void
  /** Removes the folder and everything in it. */
  close(): void
}

export function openTestRepos(): TestRepos {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-git-')))
  const sh = (command: string, cwd: string = root): string =>
    execFileSync('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...SHELL_GIT_ENV },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  const write = (path: string, text: string | Buffer): void => {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  return {
    root,
    sh,
    write,
    repo(path, files = { 'README.md': '# Acme API\n' }) {
      const dir = join(root, path)
      mkdirSync(dir, { recursive: true })
      sh('git init -q -b main', dir)
      for (const [file, text] of Object.entries(files)) write(join(path, file), text)
      sh('git add -A && git commit -q -m "Start the Acme API"', dir)
      return dir
    },
    close() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
