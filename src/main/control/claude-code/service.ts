/**
 * Listing Claude Code's sessions and importing one as a Glade task (`list_claude_code_sessions` and
 * `import_claude_code_session`, `docs/control-api.md`).
 *
 * **Listing** reads every session's transcript once and keeps a summary of it, by path, size and modification time, so
 * paging through a few hundred sessions reads each only when it changed. The summaries are only a cache: they're
 * rebuilt from the transcripts whenever they're missing.
 *
 * **Importing** reads the transcript (`./session`), then writes the task, its chat and its tool log in one
 * transaction, with their original times, and tells the windows with `task.updated` once it has committed. A session
 * already in Glade (imported before, or a Glade task's own) isn't imported again: the task that has it is returned. The
 * unique index on `session_id` keeps that true for imports that race.
 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { EventType } from '../../../shared/bridge'
import { contextWindowFor } from '../../../shared/contextWindow'
import {
  DividerKind,
  MessageRole,
  TaskState,
  ToolCallState,
  type EpochMs,
  type Task,
  type ToolEvent,
  type Workspace,
} from '../../../shared/domain'
import { MODEL_OPTIONS } from '../../../shared/models'
import { summarizeTurn } from '../../agent/turn-summary'
import { emitTaskUpdated, type Emit } from '../../bridge/events'
import { appendMessage } from '../../db/repositories/messages'
import { getSettings } from '../../db/repositories/settings'
import { createTask, getTask, updateTask } from '../../db/repositories/tasks'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendToolCall,
  updateToolCall,
} from '../../db/repositories/tool-events'
import { getWorkspaceByRoot, listWorkspaces } from '../../db/repositories/workspaces'
import { truncate } from '../../notifications/notifications'
import { refreshTodos } from '../../todos/todos'
import { createWorkspaceAt } from '../../workspaces/workspaces'
import { ControlError, ControlErrorCode } from '../errors'
import type { ClaudeCodeSessionPage } from '../service'
import { SessionLogKind, type ClaudeCodeTranscript, type SessionTurn, type SkippedCounts } from './session'
import {
  findTranscript,
  listTranscripts,
  readTranscript,
  transcriptAt,
  TranscriptProblem,
  type TranscriptFile,
} from './transcripts'

/** An imported task's status. */
export const IMPORTED_STATUS = 'Imported from Claude Code'

/** What an imported tool call with no result in the transcript says. */
export const NO_RESULT_NOTE = 'The Claude Code transcript has no result for this tool call.'

/** How long a listed first prompt, an imported title and an imported objective may be. */
export const FIRST_PROMPT_LENGTH = 200
export const TITLE_LENGTH = 80
export const OBJECTIVE_LENGTH = 500

/** One Claude Code session, as `list_claude_code_sessions` lists it. */
export interface ClaudeCodeSession {
  readonly sessionId: string
  readonly path: string
  readonly cwd: string
  /** Claude Code's own title for it, when it has one. */
  readonly title: string | null
  /** Cut to `FIRST_PROMPT_LENGTH` characters. */
  readonly firstPrompt: string
  readonly startedAt: EpochMs
  readonly lastActivityAt: EpochMs
  /** Your prompts plus the agent's replies. */
  readonly messages: number
  /** The workspace whose root is its `cwd`. */
  readonly workspaceId: string | null
  /** The Glade task that has this session, if any. */
  readonly taskId: string | null
}

export interface ListClaudeCodeSessionsInput {
  /** Only sessions started in this folder. */
  readonly cwd?: string | undefined
  /** Matched, ignoring case, against the title and first prompt. */
  readonly query?: string | undefined
  /** True: only sessions already in Glade; false: only ones that aren't. */
  readonly imported?: boolean | undefined
  /** Where the last page ended. */
  readonly cursor?: string | undefined
  /** 1–200. */
  readonly limit: number
}

/** Which session to import: by its id, or by its transcript's path. */
export type ClaudeCodeSessionRef = { readonly sessionId: string } | { readonly path: string }

export interface ImportClaudeCodeSessionInput {
  readonly session: ClaudeCodeSessionRef
  /** The state the task is imported in. */
  readonly state: TaskState
  /** Add the session's folder as a workspace when none has it as its root. */
  readonly createWorkspace: boolean
}

export interface ClaudeCodeImport {
  readonly task: Task
  /** False when the session was already in Glade, and `task` is the task that has it. */
  readonly imported: boolean
  readonly skipped: SkippedCounts
}

/** What listing and importing need. */
export interface ClaudeCodeContext {
  readonly db: Database
  readonly emit: Emit
  /** Claude Code's projects folder (`claudeProjectsDir`). */
  readonly projectsDir: string
  /** The time, for `importedAt`. */
  readonly now?: () => EpochMs
}

/** What a listing keeps of a transcript it has read. */
interface SessionSummary {
  readonly size: number
  readonly modifiedAt: EpochMs
  readonly cwd: string | null
  readonly title: string | null
  readonly firstPrompt: string | null
  readonly startedAt: EpochMs
  readonly lastActivityAt: EpochMs
  readonly messages: number
}

/** The transcripts' summaries, by path. A cache: anything missing or stale is read again. */
type SummaryCache = Map<string, SessionSummary>

async function summaryOf(cache: SummaryCache, file: TranscriptFile): Promise<SessionSummary> {
  const cached = cache.get(file.path)
  if (cached?.size === file.size && cached.modifiedAt === file.modifiedAt) return cached
  const transcript = await readTranscript(file)
  const summary: SessionSummary = {
    size: file.size,
    modifiedAt: file.modifiedAt,
    cwd: transcript.cwd,
    title: transcript.title,
    firstPrompt: transcript.firstPrompt,
    startedAt: transcript.startedAt,
    lastActivityAt: transcript.lastActivityAt,
    messages: transcript.messages,
  }
  cache.set(file.path, summary)
  return summary
}

/** Where a page of sessions ends, in the listing's order: newest first, then by session id. */
interface SessionCursor {
  readonly lastActivityAt: EpochMs
  readonly sessionId: string
}

export function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify([cursor.lastActivityAt, cursor.sessionId])).toString('base64url')
}

/** The cursor a page ended at, or null for one Glade didn't make. */
export function decodeCursor(text: string): SessionCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 2) return null
    const [lastActivityAt, sessionId] = value as unknown[]
    if (typeof lastActivityAt !== 'number' || typeof sessionId !== 'string') return null
    return { lastActivityAt, sessionId }
  } catch {
    return null
  }
}

/** Whether `a` comes before `b` in the listing's order. */
function before(a: SessionCursor, b: SessionCursor): boolean {
  return a.lastActivityAt !== b.lastActivityAt ? a.lastActivityAt > b.lastActivityAt : a.sessionId < b.sessionId
}

/** Each of these sessions' Glade task, by session id. */
function tasksBySession(db: Database, sessionIds: readonly string[]): Map<string, string> {
  const rows = db
    .prepare('SELECT session_id, id FROM tasks WHERE session_id IN (SELECT value FROM json_each(?))')
    .raw()
    .all(JSON.stringify(sessionIds)) as unknown[][]
  return new Map(
    rows.flatMap(([session, id]) => (typeof session === 'string' && typeof id === 'string' ? [[session, id]] : [])),
  )
}

/**
 * A page of Claude Code's sessions, newest first. Sessions with no messages, or that don't say which folder they ran
 * in, can't be imported and aren't listed; nor is a transcript that can't be read.
 */
async function listSessions(
  context: ClaudeCodeContext,
  cache: SummaryCache,
  input: ListClaudeCodeSessionsInput,
): Promise<ClaudeCodeSessionPage> {
  const { db, projectsDir } = context
  const files = await listTranscripts(projectsDir)
  const read = await Promise.all(
    files.map(async (file) => {
      const summary = await summaryOf(cache, file).catch(() => null)
      return summary === null ? [] : [{ file, summary }]
    }),
  )
  const cwd = input.cwd === undefined ? undefined : resolve(input.cwd)
  const query = input.query?.trim().toLowerCase() ?? ''
  const tasks = tasksBySession(
    db,
    files.map((file) => file.sessionId),
  )
  const workspaces = new Map(listWorkspaces(db).map((workspace) => [workspace.rootPath, workspace.id]))
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor)
  const sessions = read
    .flat()
    .flatMap(({ file, summary }): ClaudeCodeSession[] => {
      if (summary.cwd === null || summary.messages === 0) return []
      const taskId = tasks.get(file.sessionId) ?? null
      const firstPrompt = summary.firstPrompt ?? ''
      if (cwd !== undefined && resolve(summary.cwd) !== cwd) return []
      if (input.imported !== undefined && input.imported !== (taskId !== null)) return []
      if (query !== '' && ![summary.title ?? '', firstPrompt].some((text) => text.toLowerCase().includes(query))) {
        return []
      }
      return [
        {
          sessionId: file.sessionId,
          path: file.path,
          cwd: summary.cwd,
          title: summary.title,
          firstPrompt: truncate(firstPrompt, FIRST_PROMPT_LENGTH),
          startedAt: summary.startedAt,
          lastActivityAt: summary.lastActivityAt,
          messages: summary.messages,
          workspaceId: workspaces.get(resolve(summary.cwd)) ?? null,
          taskId,
        },
      ]
    })
    .filter((session) => after === null || before(after, session))
    .sort((a, b) => (before(a, b) ? -1 : 1))
  const page = sessions.slice(0, input.limit)
  const last = page[page.length - 1]
  return {
    sessions: page,
    nextCursor: sessions.length > input.limit && last !== undefined ? encodeCursor(last) : null,
  }
}

/** The transcript a reference names. */
async function transcriptFor(projectsDir: string, ref: ClaudeCodeSessionRef): Promise<TranscriptFile> {
  if ('sessionId' in ref) {
    const file = await findTranscript(projectsDir, ref.sessionId)
    if (file === undefined) throw new ControlError(ControlErrorCode.NotFound, `No session ${ref.sessionId}`)
    return file
  }
  const lookup = await transcriptAt(projectsDir, ref.path)
  if (lookup.ok) return lookup.file
  switch (lookup.problem) {
    case TranscriptProblem.OutsideProjects:
      throw new ControlError(
        ControlErrorCode.ImportFailed,
        `${ref.path} is not a Claude Code transcript: it must be a .jsonl file in a project's folder in ${projectsDir}`,
      )
    case TranscriptProblem.Missing:
      throw new ControlError(ControlErrorCode.ImportFailed, `No such file: ${ref.path}`)
  }
}

/**
 * The model Glade offers that the transcript's model is, by the id the SDK takes: the same id, or the same one with a
 * date or a context size after it (`claude-haiku-4-5-20251001` is Haiku 4.5). Null when Glade doesn't offer it.
 */
export function offeredModel(model: string): string | null {
  const base = (id: string): string => id.replace(/\[[^\]]*\]$/, '')
  const found = MODEL_OPTIONS.find((option) => {
    if (model === option.id || model === base(option.id)) return true
    return model.startsWith(`${base(option.id)}-`) && /^-\d{8}(\[[^\]]*\])?$/.test(model.slice(base(option.id).length))
  })
  return found?.id ?? null
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
}

/** The task's title: Claude Code's, else the first line of the first prompt. */
function titleOf(transcript: ClaudeCodeTranscript): string {
  const title = transcript.title?.trim() ?? ''
  if (title !== '') return truncate(title, TITLE_LENGTH)
  const firstLine = (transcript.firstPrompt ?? '').split('\n').find((line) => line.trim() !== '') ?? ''
  return truncate(firstLine.trim(), TITLE_LENGTH)
}

/** Whether an error is SQLite refusing a second task with the same session. */
function isSessionTaken(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
}

/** Writes one imported turn's chat and tool log. */
function writeTurn(db: Database, taskId: string, turn: SessionTurn, windowTokens: number, fallback: EpochMs): void {
  const { number } = turn
  if (turn.prompt !== null) {
    appendMessage(db, { taskId, role: MessageRole.User, body: turn.prompt.text, turn: number }, turn.prompt.at)
  }
  const started = turn.prompt?.at ?? turn.log[0]?.at ?? turn.reply?.at ?? fallback
  const events: ToolEvent[] = [appendDivider(db, { taskId, turn: number, dividerKind: DividerKind.Turn }, started)]
  for (const entry of turn.log) {
    switch (entry.kind) {
      case SessionLogKind.Narration:
        events.push(appendNarration(db, { taskId, turn: number, text: entry.text }, entry.at))
        break
      case SessionLogKind.ToolCall: {
        const { toolUseId, name, input, result } = entry
        appendToolCall(db, { taskId, turn: number, name, input, toolUseId, parentToolUseId: null }, entry.at)
        const outcome =
          result === null
            ? { state: ToolCallState.Interrupted, output: NO_RESULT_NOTE, at: entry.at }
            : { state: result.isError ? ToolCallState.Error : ToolCallState.Done, output: result.output, at: result.at }
        events.push(updateToolCall(db, { taskId, toolUseId, state: outcome.state, output: outcome.output }, outcome.at))
        break
      }
      case SessionLogKind.Compaction: {
        const { trigger, preTokens, postTokens } = entry
        const state = ToolCallState.Done
        events.push(
          appendCompaction(db, { taskId, turn: number, trigger, state, preTokens, postTokens, windowTokens }, entry.at),
        )
        break
      }
    }
  }
  if (turn.reply !== null) {
    const summary = summarizeTurn({ startedAt: turn.prompt?.at ?? null, finishedAt: turn.reply.at }, events)
    appendMessage(db, { taskId, role: MessageRole.Agent, body: turn.reply.text, turn: number, summary }, turn.reply.at)
  }
}

/** What an import's transaction did. */
interface Written {
  readonly task: Task
  readonly imported: boolean
  /** The workspace it added for the session's folder, if it added one. */
  readonly workspace: Workspace | null
}

/**
 * Imports a Claude Code session as a task (see the module comment and `docs/control-api.md`).
 *
 * @throws ControlError `not_found` for no session with that id, and `import_failed` for a path Glade may not read,
 *   a transcript with no messages, or a folder that no longer exists or no workspace has (without `createWorkspace`).
 */
async function importSession(
  context: ClaudeCodeContext,
  input: ImportClaudeCodeSessionInput,
): Promise<ClaudeCodeImport> {
  const { db, emit, projectsDir } = context
  const file = await transcriptFor(projectsDir, input.session)
  const existing = (): Task | undefined => {
    const id: unknown = db.prepare('SELECT id FROM tasks WHERE session_id = ?').pluck().get(file.sessionId)
    return typeof id === 'string' ? getTask(db, id) : undefined
  }
  const already = existing()
  if (already !== undefined) return { task: already, imported: false, skipped: { lines: 0, images: 0 } }

  const transcript = await readTranscript(file)
  const { cwd } = transcript
  if (transcript.messages === 0) {
    throw new ControlError(ControlErrorCode.ImportFailed, `The session ${file.sessionId} has no messages`)
  }
  if (cwd === null) {
    throw new ControlError(ControlErrorCode.ImportFailed, `The session ${file.sessionId} doesn't say its folder`)
  }
  const root = resolve(cwd)
  if (!isDirectory(root)) {
    throw new ControlError(ControlErrorCode.ImportFailed, `The session's folder ${root} no longer exists`)
  }

  const now = context.now?.() ?? Date.now()
  const write = db.transaction((): Written => {
    // Another import of this session may have finished while this one read the transcript.
    const raced = existing()
    if (raced !== undefined) return { task: raced, imported: false, workspace: null }
    let workspace = getWorkspaceByRoot(db, root)
    let added: Workspace | null = null
    if (workspace === undefined) {
      if (!input.createWorkspace) {
        throw new ControlError(
          ControlErrorCode.ImportFailed,
          `No workspace has the session's folder ${root} as its root; import it with createWorkspace to add one`,
        )
      }
      workspace = createWorkspaceAt(db, root, now).workspace
      added = workspace
    }
    const settings = getSettings(db)
    const model = (transcript.model === null ? null : offeredModel(transcript.model)) ?? settings.defaultModel
    const created = createTask(
      db,
      {
        workspaceId: workspace.id,
        model,
        effort: settings.defaultEffort,
        permissionMode: settings.defaultPermissionMode,
        title: titleOf(transcript),
        objective: truncate((transcript.firstPrompt ?? '').trim(), OBJECTIVE_LENGTH),
        status: IMPORTED_STATUS,
        importedAt: now,
      },
      transcript.startedAt,
    )
    const windowTokens = contextWindowFor(model)
    for (const turn of transcript.turns) writeTurn(db, created.id, turn, windowTokens, transcript.startedAt)
    // The session's todo calls leave a list, as a Glade task's do: its row shows the progress.
    refreshTodos(db, created.id)
    const task = updateTask(
      db,
      created.id,
      { sessionId: file.sessionId, state: input.state },
      Math.max(transcript.lastActivityAt, transcript.startedAt),
    )
    return { task, imported: true, workspace: added }
  })
  let written: Written
  try {
    written = write()
  } catch (error) {
    const raced = isSessionTaken(error) ? existing() : undefined
    if (raced === undefined) throw error
    written = { task: raced, imported: false, workspace: null }
  }
  if (written.workspace !== null) emit({ type: EventType.WorkspaceUpdated, workspace: written.workspace })
  if (!written.imported) return { task: written.task, imported: false, skipped: { lines: 0, images: 0 } }
  emitTaskUpdated(emit, written.task)
  return { task: written.task, imported: true, skipped: transcript.skipped }
}

/** Lists and imports Claude Code's sessions. */
export interface ClaudeCodeSessions {
  list(input: ListClaudeCodeSessionsInput): Promise<ClaudeCodeSessionPage>
  import(input: ImportClaudeCodeSessionInput): Promise<ClaudeCodeImport>
}

/** Lists and imports sessions for `context`, keeping the listing's summaries between calls. */
export function createClaudeCodeSessions(context: ClaudeCodeContext): ClaudeCodeSessions {
  const cache: SummaryCache = new Map()
  return {
    list: (input) => listSessions(context, cache, input),
    import: (input) => importSession(context, input),
  }
}
