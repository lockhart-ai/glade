/**
 * Where Claude Code keeps its transcripts, and reading them: `<projects>/<cwd slug>/<sessionId>.jsonl`, where
 * `<projects>` is `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` (`docs/sdk-notes.md` §8). Only the top-level
 * `*.jsonl` of each project folder are sessions; subagents' transcripts sit deeper and are never read.
 *
 * A transcript is read a line at a time from a stream, so a long one is never all in memory as text.
 */
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { EpochMs } from '../../../shared/domain'
import { parseTranscriptLine } from './entries'
import { SessionReader, type ClaudeCodeTranscript } from './session'

/** The environment variable that moves Claude Code's config folder, and with it the projects folder. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

const TRANSCRIPT_EXTENSION = '.jsonl'

/** A session id as a file name can hold it: Claude Code's are UUIDs. */
const SESSION_ID = /^[\w-]+$/

/** The folder Claude Code keeps its projects' transcripts in, for an environment and home folder. */
export function claudeProjectsDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const configured = env[CLAUDE_CONFIG_DIR_ENV]
  return join(configured === undefined || configured === '' ? join(home, '.claude') : resolve(configured), 'projects')
}

/** A transcript file, found in the projects folder. */
export interface TranscriptFile {
  readonly path: string
  readonly sessionId: string
  readonly size: number
  readonly modifiedAt: EpochMs
}

/** Why a transcript can't be read. */
export enum TranscriptProblem {
  /** The path isn't a `.jsonl` file directly in one of the projects folder's own folders. */
  OutsideProjects = 'outside_projects',
  /** There's no such file. */
  Missing = 'missing',
}

/** A transcript Glade may read, or why it may not. */
export type TranscriptLookup =
  { readonly ok: true; readonly file: TranscriptFile } | { readonly ok: false; readonly problem: TranscriptProblem }

/** Whether `path` is `folder` or inside it, both already resolved. */
function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** The real path of `path`, or null when there's nothing there. */
async function realPathOf(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

/**
 * The transcript at `path`, if Glade may read it: an absolute path to a `.jsonl` file directly inside one of the
 * projects folder's own folders, which is still there once symlinks are followed (so neither `..` nor a link leads out
 * of it).
 */
export async function transcriptAt(projectsDir: string, path: string): Promise<TranscriptLookup> {
  const outside = { ok: false, problem: TranscriptProblem.OutsideProjects } as const
  if (!isAbsolute(path) || !path.endsWith(TRANSCRIPT_EXTENSION)) return outside
  const projects = resolve(projectsDir)
  const resolved = resolve(path)
  // Directly in a project's folder: `<projects>/<slug>/<file>.jsonl`.
  if (dirname(dirname(resolved)) !== projects) return outside
  const realProjects = await realPathOf(projects)
  const real = await realPathOf(resolved)
  if (realProjects === null || real === null) return { ok: false, problem: TranscriptProblem.Missing }
  if (!isInside(realProjects, real) || relative(realProjects, real).split(sep).length !== 2) return outside
  const info = await stat(real)
  if (!info.isFile()) return { ok: false, problem: TranscriptProblem.Missing }
  return {
    ok: true,
    file: {
      path: resolved,
      sessionId: basename(resolved, TRANSCRIPT_EXTENSION),
      size: info.size,
      modifiedAt: Math.floor(info.mtimeMs),
    },
  }
}

/** The folders directly in `folder`, or none when it can't be read. */
async function subfolders(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name))
  } catch {
    return []
  }
}

/** Every session's transcript in the projects folder, in no particular order. None when the folder isn't there. */
export async function listTranscripts(projectsDir: string): Promise<TranscriptFile[]> {
  const projects = resolve(projectsDir)
  const found = await Promise.all(
    (await subfolders(projects)).map(async (folder) => {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXTENSION))
      return Promise.all(
        files.map(async (entry): Promise<TranscriptFile | null> => {
          const path = join(folder, entry.name)
          const info = await stat(path).catch(() => null)
          if (info === null) return null
          return {
            path,
            sessionId: basename(entry.name, TRANSCRIPT_EXTENSION),
            size: info.size,
            modifiedAt: Math.floor(info.mtimeMs),
          }
        }),
      )
    }),
  )
  return found.flat().filter((file): file is TranscriptFile => file !== null)
}

/** The transcript of the session with this id, from any project's folder, or undefined when there's none. */
export async function findTranscript(projectsDir: string, sessionId: string): Promise<TranscriptFile | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined
  for (const folder of await subfolders(resolve(projectsDir))) {
    const lookup = await transcriptAt(projectsDir, join(folder, `${sessionId}${TRANSCRIPT_EXTENSION}`))
    if (lookup.ok) return lookup.file
  }
  return undefined
}

/**
 * Reads a transcript, a line at a time, into the session it holds. A line that isn't an entry Glade knows (a truncated
 * last line, say) is skipped and counted; blank lines are ignored.
 */
export async function readTranscript(file: TranscriptFile): Promise<ClaudeCodeTranscript> {
  const reader = new SessionReader(file.modifiedAt)
  const lines = createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    const entry = parseTranscriptLine(line)
    if (entry === null) reader.skipLine()
    else reader.add(entry)
  }
  return reader.finish()
}
