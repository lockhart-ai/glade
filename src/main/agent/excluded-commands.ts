/**
 * The commands the user's own Claude Code settings keep out of the sandbox (#514, `docs/sdk-notes.md` §15).
 *
 * A session reads the user's, the project's and the local Claude Code settings (`settingSources`), and their
 * `sandbox.excludedCommands` lists merge with Glade's own, which can't take an entry away. A command one of those
 * patterns covers runs **outside** the sandbox without asking to (no `dangerouslyDisableSandbox`), and in Allow all it
 * would run unasked. Nothing Claude Code tells Glade about a call says it was excluded, so Glade reads the same files
 * itself and asks about a command that an entry may cover, with the run-outside-the-sandbox card
 * (`../permissions/sandbox-classify`).
 *
 * - **Which files:** Claude Code's managed settings, the user's (`~/.claude/settings.json`), the project's
 *   (`<root>/.claude/settings.json`) and the local ones (`<root>/.claude/settings.local.json`). Each is read when a
 *   command is first checked, and again once it has changed on disk, looked at no more than once a second: Claude Code
 *   picks a changed file up while a session runs. A file that's missing, unreadable or not the JSON expected adds
 *   nothing, as Claude Code ignores it.
 * - **Which commands:** matching errs on the side of asking. Claude Code runs a command outside the sandbox when every
 *   part of it matches a pattern, by rules of its own (prefixes, wildcards, wrappers stripped). Glade asks when any
 *   word of the command, quotes and backslashes aside, is the command a pattern names: `docker *` covers
 *   `docker ps`, `cd x && docker ps`, `FOO=1 /usr/local/bin/docker ps` and `echo docker` alike. A card too many, for a
 *   command the user chose to exclude, is the cheap side to be wrong on.
 * - **Not followed:** a settings folder moved with `CLAUDE_CONFIG_DIR` in the login shell only (Glade's own
 *   environment is what's read), managed settings delivered by MDM or a server rather than the file, and a plugin's
 *   settings.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

/** Claude Code's managed settings on macOS: an administrator's, read whatever `settingSources` says. */
export const MANAGED_SETTINGS_FILE = '/Library/Application Support/ClaudeCode/managed-settings.json'

/** The settings files of a project: the ones it commits, and the local ones it doesn't. */
export function projectSettingsFiles(root: string): string[] {
  return [join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')]
}

/** The environment variable that moves Claude Code's config folder, and with it the user's settings file. */
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/**
 * The settings files Claude Code merges for a session in `root`, as far as Glade follows them (see the module comment):
 * the managed ones, the user's (in `$CLAUDE_CONFIG_DIR`, or `.claude` under `home`), and the project's.
 */
export function claudeSettingsFiles(
  root: string,
  home: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const configured = env[CLAUDE_CONFIG_DIR_ENV]
  const config = configured === undefined || configured === '' ? join(home, '.claude') : resolve(configured)
  return [MANAGED_SETTINGS_FILE, join(config, 'settings.json'), ...projectSettingsFiles(root)]
}

/**
 * What names a session's settings files by its workspace root (`AgentRunnerOptions.claudeSettings`): every one Claude
 * Code merges, for the user whose home folder is `home`; or, with no home folder (a test mode, which never reads the
 * settings of the Mac it runs on), the project's own alone.
 */
export function sessionSettingsFiles(home: string | null): (root: string) => string[] {
  return home === null ? projectSettingsFiles : (root) => claudeSettingsFiles(root, home)
}

const settingsSchema = z.looseObject({
  sandbox: z.looseObject({ excludedCommands: z.array(z.unknown()).optional().catch(undefined) }).optional(),
})

/** The patterns a settings file's text excludes from the sandbox; none for text that isn't the JSON expected. */
export function excludedPatterns(text: string): string[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const parsed = settingsSchema.safeParse(json)
  const listed = parsed.success ? (parsed.data.sandbox?.excludedCommands ?? []) : []
  return listed.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim() !== '')
}

/** What separates a command's words: white space, and the shell's own punctuation. */
const WORD_BREAKS = /[\s;|&(){}<>`$=,]+/

/** A path's last part: `/usr/local/bin/docker` is `docker`. */
function lastPart(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/**
 * The command a pattern names, in Bash permission-rule syntax: its first word, without a `:*` after it. `docker *`,
 * `docker:*` and `docker` all name `docker`.
 */
function patternCommand(pattern: string): string {
  const [first = ''] = pattern.trim().split(/\s+/)
  return first.replace(/:\*$/, '')
}

/** A name with `*` in it as an expression matching a whole word: `npm*` matches `npm` and `npmx`. */
function wildcard(name: string): RegExp {
  const escaped = name.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`)
}

/**
 * Whether one of `patterns` may cover `command`, so that Claude Code would run it outside the sandbox (see the module
 * comment): a word of the command, or the last part of a path in it, is the command the pattern names.
 */
export function mayBeExcluded(command: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  const words = command
    .replace(/['"\\]/g, '')
    .split(WORD_BREAKS)
    .filter((word) => word !== '')
  const named = new Set(words.flatMap((word) => [word, lastPart(word)]))
  return patterns.some((pattern) => {
    const name = patternCommand(pattern)
    if (name.includes('*')) {
      const matches = wildcard(name)
      return [...named].some((word) => matches.test(word))
    }
    return named.has(name) || named.has(lastPart(name))
  })
}

/** How often, at most, the settings files are looked at for a change, in ms. */
export const SETTINGS_REFRESH_MS = 1000

/** A settings file as last read: what it was on disk then, and the patterns it listed. */
interface ReadFile {
  /** Its modification time and size when read, as one value; null when it wasn't there. */
  readonly stamp: string | null
  readonly patterns: readonly string[]
}

/** How the excluded commands are read. */
export interface ExcludedCommandsOptions {
  /** The settings files to read (`claudeSettingsFiles`). */
  readonly files: readonly string[]
  /** The time, in ms: the clock by default. */
  readonly now?: () => number
  /** Where a file that can't be read is noted. Nothing by default. */
  readonly log?: Logger
}

/** The commands the settings exclude from the sandbox, as they stand on disk. */
export interface ExcludedCommands {
  /** Whether a pattern in one of the files may cover `command` (`mayBeExcluded`). */
  matches(command: string): boolean
}

/** A file's modification time and size, as one value; null when there's no file there. */
function stampOf(file: string): string | null {
  try {
    const info = statSync(file)
    return `${String(info.mtimeMs)}:${String(info.size)}`
  } catch {
    return null
  }
}

/**
 * The excluded commands of some settings files (see the module comment): each file read when first needed, and again
 * when it has changed, looked at no more than once every `SETTINGS_REFRESH_MS`.
 */
export function createExcludedCommands({
  files,
  now = Date.now,
  log = SILENT_LOGGER,
}: ExcludedCommandsOptions): ExcludedCommands {
  const read = new Map<string, ReadFile>()
  let patterns: readonly string[] = []
  let checkedAt: number | null = null
  const refresh = (): void => {
    const time = now()
    if (checkedAt !== null && time - checkedAt < SETTINGS_REFRESH_MS) return
    checkedAt = time
    let changed = false
    for (const file of files) {
      const stamp = stampOf(file)
      const last = read.get(file)
      if (last?.stamp === stamp) continue
      changed = true
      let listed: string[] = []
      if (stamp !== null) {
        try {
          listed = excludedPatterns(readFileSync(file, 'utf8'))
        } catch (error) {
          log.warn("couldn't read a Claude Code settings file for its excluded commands", { file, error })
        }
      }
      read.set(file, { stamp, patterns: listed })
    }
    if (changed) patterns = [...new Set([...read.values()].flatMap((file) => file.patterns))]
  }
  return {
    matches(command) {
      refresh()
      return mayBeExcluded(command, patterns)
    },
  }
}
