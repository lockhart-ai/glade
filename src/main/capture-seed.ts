/**
 * Sample data for screenshots and e2e specs: `npm run screenshot -- --seed <fixture>` (or an e2e spec's `seed`) fills
 * the throwaway database from a JSON fixture before the window opens, so a capture or a spec can show a populated app.
 * Only the test modes use it.
 */
import { readFileSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type EpochMs,
  type ToolInput,
  type TurnSummary,
} from '../shared/domain'
import { appendMessage } from './db/repositories/messages'
import { appendQueuedMessage } from './db/repositories/queued-messages'
import { createTask, updateTask } from './db/repositories/tasks'
import { appendDivider, appendNarration, appendToolCall, updateToolCall } from './db/repositories/tool-events'
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

/** A sample tool call. It's still running unless it has an output, and done with it unless it `failed`. */
export interface SeedToolCall {
  readonly kind: ToolEventKind.ToolCall
  readonly name: string
  readonly input: ToolInput
  readonly output?: string | undefined
  /** Whether the call failed; its output is then the error. */
  readonly failed?: boolean | undefined
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

/** One sample tool log entry. */
export type SeedToolEvent = SeedNarration | SeedToolCall | SeedDivider

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
}

/** A fixture: one workspace, opened, and its tasks. */
export interface CaptureSeed {
  readonly workspace: { readonly name: string; readonly rootPath: string }
  readonly tasks: readonly SeedTask[]
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
    failed: z.boolean().optional(),
    toolUseId: z.string().optional(),
    parentToolUseId: z.string().optional(),
    turn,
    minutesAgo,
  }),
  z.strictObject({ kind: z.literal(ToolEventKind.Divider), dividerKind: z.enum(DividerKind), turn, minutesAgo }),
])

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
    }),
  ),
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
  return parsed.data
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
      if (output !== undefined) {
        const state = event.failed === true ? ToolCallState.Error : ToolCallState.Done
        updateToolCall(db, { taskId, toolUseId, state, output })
      }
      return
    }
  }
}

/** Writes a seed into the database as if it had been used up to `now`: the workspace open, the selected task shown. */
export function applySeed(db: Database, seed: CaptureSeed, now: EpochMs = Date.now()): void {
  db.transaction(() => {
    const workspace = createWorkspace(db, seed.workspace, now)
    setUiState(db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
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
    }
  })()
}
