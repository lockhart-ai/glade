/**
 * Sample data for screenshots and e2e specs: `npm run screenshot -- --seed <fixture>` (or an e2e spec's `seed`) fills
 * the throwaway database from a JSON fixture before the window opens, so a capture or a spec can show a populated app.
 * Only the test modes use it.
 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  AgentErrorKind,
  CompactionTrigger,
  DividerKind,
  MessageRole,
  PauseReason,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type EpochMs,
  type TaskError,
  type ToolInput,
  type TurnSummary,
} from '../shared/domain'
import { serializeRelaunchNotice } from '../shared/relaunchNotice'
import { appendMessage } from './db/repositories/messages'
import { setOpenFiles } from './db/repositories/open-files'
import { appendQueuedMessage } from './db/repositories/queued-messages'
import { createTask, updateTask } from './db/repositories/tasks'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendToolCall,
  updateToolCall,
} from './db/repositories/tool-events'
import { setUiState } from './db/repositories/ui-state'
import { createWorkspace } from './db/repositories/workspaces'
import { DEFAULT_EFFORT, DEFAULT_MODEL } from './tasks/defaults'

const MINUTE = 60_000

/** One sample chat message. */
export interface SeedMessage {
  readonly role: MessageRole
  /** Markdown. */
  readonly body: string
  readonly turn: number
  /** How long before the capture it was sent. */
  readonly minutesAgo: number
  /** An agent reply's turn summary; none unless given. */
  readonly summary?: TurnSummary | undefined
}

/** A sample note from the agent in the tool log. */
export interface SeedNarration {
  readonly kind: ToolEventKind.Narration
  readonly text: string
  readonly turn: number
  readonly minutesAgo: number
}

/** A sample tool call. It's still running unless it has an output, and done with it unless it has another `state`. */
export interface SeedToolCall {
  readonly kind: ToolEventKind.ToolCall
  readonly name: string
  readonly input: ToolInput
  readonly output?: string | undefined
  /** How the call ended, with its output: done unless given (e.g. `error`, when its output is the error). */
  readonly state?: FinishedToolCallState | undefined
  /** Its `tool_use` id, for a subagent's calls to name as their parent; generated when not given. */
  readonly toolUseId?: string | undefined
  /** The `toolUseId` of the `Agent` call whose subagent made this call; top level when not given. */
  readonly parentToolUseId?: string | undefined
  readonly turn: number
  readonly minutesAgo: number
}

/** A sample divider in the tool log. */
export interface SeedDivider {
  readonly kind: ToolEventKind.Divider
  readonly dividerKind: DividerKind
  readonly turn: number
  readonly minutesAgo: number
}

/** A sample compaction (`CompactionEvent`), done unless it has another `state`. */
export interface SeedCompaction {
  readonly kind: ToolEventKind.Compaction
  readonly trigger: CompactionTrigger
  readonly state?: ToolCallState | undefined
  readonly preTokens: number | null
  readonly postTokens: number | null
  readonly windowTokens: number
  readonly turn: number
  readonly minutesAgo: number
}

/** One sample tool log entry. */
export type SeedToolEvent = SeedNarration | SeedToolCall | SeedDivider | SeedCompaction

/** The states a sample tool call with an output can end in: any but running. */
export type FinishedToolCallState = Exclude<ToolCallState, ToolCallState.Running>

const FINISHED_TOOL_CALL_STATES = Object.values(ToolCallState).filter(
  (state): state is FinishedToolCallState => state !== ToolCallState.Running,
)

/** One sample task. Its times are relative to the capture, so relative times read the same on every run. */
export interface SeedTask {
  readonly title: string
  readonly objective?: string | undefined
  readonly status?: string | undefined
  readonly state?: TaskState | undefined
  /** What the task's agent is doing; waiting unless given. */
  readonly activity?: TaskActivity | undefined
  readonly pinned?: boolean | undefined
  readonly unread?: boolean | undefined
  /** How much context the task's agent has used, in tokens; none unless given. */
  readonly contextUsedTokens?: number | undefined
  /** The task's context window, in tokens; its model's unless given. */
  readonly contextWindowTokens?: number | undefined
  /** How long before the capture the task was last updated (and its status set, and it was marked done). */
  readonly minutesAgo: number
  /** How long before the capture the task was created; `minutesAgo` unless given. */
  readonly startedMinutesAgo?: number | undefined
  /** Select this task. */
  readonly selected?: boolean | undefined
  /** Its chat log, in order. */
  readonly messages?: readonly SeedMessage[] | undefined
  /** Its tool log, in order. */
  readonly toolEvents?: readonly SeedToolEvent[] | undefined
  /** The messages waiting in its queue, in order. */
  readonly queuedMessages?: readonly string[] | undefined
  /** What stopped its agent, with `activity: "error"`; none unless given. */
  readonly error?: TaskError | undefined
  /** Why its turn is paused, with `activity: "paused"`; none unless given. */
  readonly pause?: SeedPause | undefined
  /** Whether the relaunch notice names it, as a task Glade picked up again after it crashed. */
  readonly resumedAfterCrash?: boolean | undefined
  /** The files open in its Files tab, relative to the workspace root, and the one showing; none unless given. */
  readonly openFiles?: SeedOpenFiles | undefined
}

/** A task's open files (`OpenFiles`). */
export interface SeedOpenFiles {
  readonly paths: readonly string[]
  /** The one showing; the first unless given. */
  readonly activePath?: string | undefined
}

/** A sample pause (`TaskPause`), with its times relative to the capture. */
export interface SeedPause {
  readonly reason: PauseReason
  /** How long after the capture it resumes. */
  readonly resumesInMinutes: number
  readonly details: string
}

/** A fixture: one workspace, opened, and its tasks. */
export interface CaptureSeed {
  /**
   * The workspace. Its root is usually made up (the Files tab then finds no files); a relative root is a folder beside
   * the fixture, for a capture that shows files.
   */
  readonly workspace: { readonly name: string; readonly rootPath: string }
  readonly tasks: readonly SeedTask[]
  /** More UI state, e.g. the right panel's tab and width. */
  readonly uiState?: Readonly<Partial<Record<UiStateKey, string>>> | undefined
}

const turn = z.int().positive()
const minutesAgo = z.number().nonnegative()
const count = z.int().nonnegative()

const seedSummarySchema = z.strictObject({
  durationMs: count.nullable(),
  filesChanged: count,
  linesAdded: count,
  linesRemoved: count,
})

const seedToolEventSchema: z.ZodType<SeedToolEvent> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(ToolEventKind.Narration), text: z.string(), turn, minutesAgo }),
  z.strictObject({
    kind: z.literal(ToolEventKind.ToolCall),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.string().optional(),
    state: z.enum(FINISHED_TOOL_CALL_STATES).optional(),
    toolUseId: z.string().optional(),
    parentToolUseId: z.string().optional(),
    turn,
    minutesAgo,
  }),
  z.strictObject({ kind: z.literal(ToolEventKind.Divider), dividerKind: z.enum(DividerKind), turn, minutesAgo }),
  z.strictObject({
    kind: z.literal(ToolEventKind.Compaction),
    trigger: z.enum(CompactionTrigger),
    state: z.enum(ToolCallState).optional(),
    preTokens: count.nullable(),
    postTokens: count.nullable(),
    windowTokens: z.int().positive(),
    turn,
    minutesAgo,
  }),
])

const seedErrorSchema = z.strictObject({
  kind: z.enum(AgentErrorKind),
  source: z.enum(TaskErrorSource),
  status: z.int().nullable(),
  code: z.string().nullable(),
  details: z.string(),
  retries: count,
  retryingMs: count,
}) satisfies z.ZodType<TaskError>

const seedPauseSchema = z.strictObject({
  reason: z.enum(PauseReason),
  resumesInMinutes: minutesAgo,
  details: z.string(),
}) satisfies z.ZodType<SeedPause>

const seedSchema: z.ZodType<CaptureSeed> = z.strictObject({
  workspace: z.strictObject({ name: z.string(), rootPath: z.string() }),
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      objective: z.string().optional(),
      status: z.string().optional(),
      state: z.enum(TaskState).optional(),
      activity: z.enum(TaskActivity).optional(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      contextUsedTokens: z.int().nonnegative().optional(),
      contextWindowTokens: z.int().positive().optional(),
      minutesAgo,
      startedMinutesAgo: minutesAgo.optional(),
      selected: z.boolean().optional(),
      messages: z
        .array(
          z.strictObject({
            role: z.enum(MessageRole),
            body: z.string(),
            turn,
            minutesAgo,
            summary: seedSummarySchema.optional(),
          }),
        )
        .optional(),
      toolEvents: z.array(seedToolEventSchema).optional(),
      queuedMessages: z.array(z.string()).optional(),
      error: seedErrorSchema.optional(),
      pause: seedPauseSchema.optional(),
      resumedAfterCrash: z.boolean().optional(),
      openFiles: z.strictObject({ paths: z.array(z.string()), activePath: z.string().optional() }).optional(),
    }),
  ),
  uiState: z.partialRecord(z.enum(UiStateKey), z.string()).optional(),
})

/** Reads and checks a seed fixture. Throws when it can't be read or isn't a valid fixture. */
export function readSeed(path: string): CaptureSeed {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`the seed ${path} can't be read: ${(error as Error).message}`, { cause: error })
  }
  const parsed = seedSchema.safeParse(json)
  if (!parsed.success) throw new Error(`the seed ${path} is invalid: ${z.prettifyError(parsed.error)}`)
  const { workspace } = parsed.data
  return isAbsolute(workspace.rootPath)
    ? parsed.data
    : { ...parsed.data, workspace: { ...workspace, rootPath: resolve(dirname(path), workspace.rootPath) } }
}

function seedToolEvent(db: Database, taskId: string, event: SeedToolEvent, at: EpochMs, seedId: string): void {
  switch (event.kind) {
    case ToolEventKind.Narration:
      appendNarration(db, { taskId, turn: event.turn, text: event.text }, at)
      return
    case ToolEventKind.Divider:
      appendDivider(db, { taskId, turn: event.turn, dividerKind: event.dividerKind }, at)
      return
    case ToolEventKind.ToolCall: {
      const { name, input, output, turn } = event
      const toolUseId = event.toolUseId ?? seedId
      appendToolCall(db, { taskId, turn, name, input, toolUseId, parentToolUseId: event.parentToolUseId ?? null }, at)
      if (output !== undefined)
        updateToolCall(db, { taskId, toolUseId, state: event.state ?? ToolCallState.Done, output })
      return
    }
    case ToolEventKind.Compaction: {
      const { trigger, preTokens, postTokens, windowTokens, turn } = event
      const state = event.state ?? ToolCallState.Done
      appendCompaction(db, { taskId, turn, trigger, state, preTokens, postTokens, windowTokens }, at)
      return
    }
  }
}

/** Writes a seed into the database as if it had been used up to `now`: the workspace open, the selected task shown. */
export function applySeed(db: Database, seed: CaptureSeed, now: EpochMs = Date.now()): void {
  db.transaction(() => {
    const workspace = createWorkspace(db, seed.workspace, now)
    setUiState(db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
    const resumed: string[] = []
    for (const [index, sample] of seed.tasks.entries()) {
      const at = now - sample.minutesAgo * MINUTE
      const createdAt = now - (sample.startedMinutesAgo ?? sample.minutesAgo) * MINUTE
      const newTask = { workspaceId: workspace.id, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT }
      const task = createTask(db, newTask, createdAt)
      updateTask(
        db,
        task.id,
        {
          title: sample.title,
          objective: sample.objective ?? '',
          status: sample.status ?? '',
          state: sample.state ?? TaskState.Active,
          activity: sample.activity ?? TaskActivity.Waiting,
          pinned: sample.pinned ?? false,
          unread: sample.unread ?? false,
          contextUsedTokens: sample.contextUsedTokens,
          contextWindowTokens: sample.contextWindowTokens,
          error: sample.error ?? null,
          pause:
            sample.pause === undefined
              ? null
              : {
                  reason: sample.pause.reason,
                  since: at,
                  resumesAt: now + sample.pause.resumesInMinutes * MINUTE,
                  checks: 0,
                  details: sample.pause.details,
                },
          // A titled task has run (its agent named it), so it has a session: e.g. it can need you.
          sessionId: sample.title === '' ? null : `seed-session-${String(index)}`,
        },
        at,
      )
      if (sample.selected === true) setUiState(db, { key: UiStateKey.SelectedTaskId, value: task.id })
      const ago = (minutes: number): EpochMs => now - minutes * MINUTE
      for (const message of sample.messages ?? []) {
        appendMessage(
          db,
          { taskId: task.id, role: message.role, body: message.body, turn: message.turn, summary: message.summary },
          ago(message.minutesAgo),
        )
      }
      for (const [index, event] of (sample.toolEvents ?? []).entries()) {
        seedToolEvent(db, task.id, event, ago(event.minutesAgo), `seed-${String(index)}`)
      }
      for (const body of sample.queuedMessages ?? []) appendQueuedMessage(db, { taskId: task.id, body }, now)
      if (sample.openFiles !== undefined) {
        const { paths, activePath } = sample.openFiles
        setOpenFiles(db, { taskId: task.id, paths, activePath: activePath ?? paths[0] ?? null })
      }
      if (sample.resumedAfterCrash === true) resumed.push(task.id)
    }
    if (resumed.length > 0) {
      setUiState(db, { key: UiStateKey.RelaunchNotice, value: serializeRelaunchNotice({ taskIds: resumed }) })
    }
    for (const [key, value] of Object.entries(seed.uiState ?? {})) {
      // The schema only lets UI state keys in.
      setUiState(db, { key: key as UiStateKey, value })
    }
  })()
}
