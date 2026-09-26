/**
 * What a `Bash` call's command and output say about the commits it may make, for the Changes tab (`./tracker`). Pure:
 * each takes text and answers with what it read from it.
 */
import { isAbsolute, resolve } from 'node:path'

/** The most folders one command is looked at in: its own, and those it names. */
export const MAX_TARGETS = 8

/** A commit a command printed, as `git commit` (or an amend, a cherry-pick…) prints it: `[main a1b2c3d] Fix the test`. */
export interface PrintedCommit {
  /** The branch it names; null for a commit on a detached HEAD. */
  readonly branch: string | null
  /** The hash as printed: short, usually. */
  readonly hash: string
  readonly subject: string
}

/** A folder a command names, quoted or not; null for one that needs the shell to expand it (`$HOME/…`, `` `pwd` ``). */
function unquote(word: string, home: string): string | null {
  let path = word
  const quote = path.charAt(0)
  if ((quote === '"' || quote === "'") && path.endsWith(quote) && path.length >= 2) path = path.slice(1, -1)
  if (/[$`*?]/.test(path) || path === '' || path === '-') return null
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`
  return path
}

/** A word of a command: quoted, or up to the next space or shell operator. */
const WORD = String.raw`("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|()]+)`

/** `cd <dir>` at the start of the command or of one of its parts (after `&&`, `;`, `|`, `(` or a new line). */
const CD = new RegExp(String.raw`(?:^|[;&|(\n])\s*cd\s+(?:--\s+)?${WORD}`, 'g')

/** `git … -C <dir>`: git run in another folder. */
const GIT_C = new RegExp(String.raw`\bgit\b[^;&|\n]*?\s-C\s+${WORD}`, 'g')

/**
 * The folders a `Bash` command may commit in: the one it starts in (`cwd`), then each it changes to (`cd`) or runs git
 * in (`git -C`), in order, each resolved from the folder the command is in by then. At most `MAX_TARGETS`, without
 * repeats. Commits a script makes in a folder the command doesn't name are only seen in `cwd`'s repository.
 */
export function commandTargets(command: string, cwd: string, home: string): string[] {
  const found: { at: number; kind: 'cd' | 'git'; word: string }[] = []
  for (const match of command.matchAll(CD)) found.push({ at: match.index, kind: 'cd', word: match[1] ?? '' })
  for (const match of command.matchAll(GIT_C)) found.push({ at: match.index, kind: 'git', word: match[1] ?? '' })
  found.sort((a, b) => a.at - b.at)
  const targets = [cwd]
  let current = cwd
  for (const { kind, word } of found) {
    const path = unquote(word, home)
    if (path === null) continue
    const dir = isAbsolute(path) ? resolve(path) : resolve(current, path)
    if (kind === 'cd') current = dir
    if (!targets.includes(dir)) targets.push(dir)
  }
  return targets.slice(0, MAX_TARGETS)
}

/**
 * Whether a reflog entry is a commit being made, rather than `HEAD` moving to one that was there (a checkout, a reset,
 * a fast-forward): a commit (the first, an amend, a merge's), a merge that made a merge commit (`merge` or `pull`),
 * a cherry-pick or a revert. A rebase's rewritten commits aren't counted.
 */
export function isCommitEntry(subject: string): boolean {
  return (
    /^commit(?: \((?:initial|amend|merge)\))?: /.test(subject) ||
    /^(?:cherry-pick|revert)\b[^:]*: /.test(subject) ||
    /^(?:merge|pull)\b[^:]*: Merge made by /.test(subject)
  )
}

/** Whether a reflog entry is an amend: the commit it made replaces the one `HEAD` was at. */
export function isAmendEntry(subject: string): boolean {
  return subject.startsWith('commit (amend): ')
}

/** `[main a1b2c3d] Fix the test`, `[main (root-commit) a1b2c3d] First`, `[detached HEAD a1b2c3d] Try`. */
const PRINTED = /^\[(\S+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/gm
const PRINTED_DETACHED = /^\[detached HEAD ([0-9a-f]{7,40})\] (.*)$/gm

/** The commits a command's output says it made, in the order it printed them, each once. */
export function printedCommits(output: string): PrintedCommit[] {
  const found: { at: number; commit: PrintedCommit }[] = []
  for (const match of output.matchAll(PRINTED)) {
    const [, branch = '', hash = '', subject = ''] = match
    found.push({ at: match.index, commit: { branch, hash, subject } })
  }
  for (const match of output.matchAll(PRINTED_DETACHED)) {
    const [, hash = '', subject = ''] = match
    found.push({ at: match.index, commit: { branch: null, hash, subject } })
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => a.at - b.at)
    .map(({ commit }) => commit)
    .filter(({ hash }) => !seen.has(hash) && seen.add(hash).size > 0)
}
