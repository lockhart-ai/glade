/**
 * Sample data for screenshots and e2e specs: `npm run screenshot -- --seed <fixture>` (or an e2e spec's `seed`) fills
 * the throwaway database from a JSON fixture before the window opens, so a capture or a spec can show a populated app.
 * Only the test modes use it.
 */
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  AgentErrorKind,
  CompactionTrigger,
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionMode,
  PermissionRequestState,
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
import { addArtifact } from './db/repositories/artifacts'
import { appendMessage } from './db/repositories/messages'
import {
  appendPermissionRequest,
  closePermissionRequest,
  type PermissionRequestClosing,
} from './db/repositories/permission-requests'
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
import { DEFAULT_SETTINGS } from '../shared/settings'

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
  /** The `toolUseId` of the `Agent` call whose subagent wrote it; the agent's own note when not given. */
  readonly parentToolUseId?: string | undefined
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
  /** How long before the capture its result arrived, when it has one; `minutesAgo` unless given. */
  readonly finishedMinutesAgo?: number | undefined
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

/**
 * A sample permission request (`PermissionRequest`): a tool call waiting on your OK, or that waited on it, open unless
 * it has another `state`.
 */
export interface SeedPermissionRequest {
  readonly toolName: string
  readonly input: ToolInput
  /** The call's `tool_use` id, which its tool log row has too (a subagent's names its `Agent` call as its parent). */
  readonly toolUseId: string
  /** The SDK's id for the subagent that made the call; the agent's own call when not given. */
  readonly agentId?: string | undefined
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly defaultToNo?: boolean | undefined
  readonly state?: PermissionRequestState | undefined
  /** The note it was denied with. */
  readonly denyNote?: string | undefined
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
  /** The files the agent declared as its deliverables (the Artifacts tab), in the order it declared them. */
  readonly artifacts?: readonly SeedArtifact[] | undefined
  /** What its agent may do without asking; Allow all unless given. */
  readonly permissionMode?: PermissionMode | undefined
  /** Its agent's tool calls that wait, or waited, on your OK, in the order they asked. */
  readonly permissionRequests?: readonly SeedPermissionRequest[] | undefined
}

/**
 * A sample artifact (`Artifact`), relative to the workspace root. Declared `minutesAgo`; its file, when the workspace
 * has one there, is marked as last changed then too, which is the age its card shows.
 */
export interface SeedArtifact {
  readonly path: string
  readonly title: string
  readonly minutesAgo: number
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
  /** The right panel's tab to open on (`PanelTab`, e.g. `subagents`); Tool calls unless given. */
  readonly panelTab?: string | undefined
  /** The right panel's width, in CSS pixels; the default unless given. */
  readonly panelWidth?: number | undefined
  /** The panels to show collapsed; each is open unless given. */
  readonly collapsed?: SeedCollapsed | undefined
}

/** Which panels a seed collapses. */
export interface SeedCollapsed {
  readonly sidebar?: boolean | undefined
  readonly rightPanel?: boolean | undefined
  readonly bottomBar?: boolean | undefined
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
  z.strictObject({
    kind: z.literal(ToolEventKind.Narration),
    text: z.string(),
    parentToolUseId: z.string().optional(),
    turn,
    minutesAgo,
  }),
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
    finishedMinutesAgo: minutesAgo.optional(),
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
  panelTab: z.string().optional(),
  panelWidth: z.int().positive().optional(),
  collapsed: z
    .strictObject({
      sidebar: z.boolean().optional(),
      rightPanel: z.boolean().optional(),
      bottomBar: z.boolean().optional(),
    })
    .optional(),
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
      artifacts: z.array(z.strictObject({ path: z.string(), title: z.string(), minutesAgo })).optional(),
      permissionMode: z.enum(PermissionMode).optional(),
      permissionRequests: z
        .array(
          z.strictObject({
            toolName: z.string(),
            input: z.record(z.string(), z.unknown()),
            toolUseId: z.string(),
            agentId: z.string().optional(),
            title: z.string().optional(),
            description: z.string().optional(),
            defaultToNo: z.boolean().optional(),
            state: z.enum(PermissionRequestState).optional(),
            denyNote: z.string().optional(),
            turn,
            minutesAgo,
          }),
        )
        .optional(),
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
  const { workspace } = parsed.data
  return isAbsolute(workspace.rootPath)
    ? parsed.data
    : { ...parsed.data, workspace: { ...workspace, rootPath: resolve(dirname(path), workspace.rootPath) } }
}

function seedToolEvent(db: Database, taskId: string, event: SeedToolEvent, now: EpochMs, seedId: string): void {
  const at = now - event.minutesAgo * MINUTE
  switch (event.kind) {
    case ToolEventKind.Narration: {
      const { turn, text, parentToolUseId } = event
      appendNarration(db, { taskId, turn, text, parentToolUseId }, at)
      return
    }
    case ToolEventKind.Divider:
      appendDivider(db, { taskId, turn: event.turn, dividerKind: event.dividerKind }, at)
      return
    case ToolEventKind.ToolCall: {
      const { name, input, output, turn } = event
      const toolUseId = event.toolUseId ?? seedId
      appendToolCall(db, { taskId, turn, name, input, toolUseId, parentToolUseId: event.parentToolUseId ?? null }, at)
      if (output !== undefined) {
        const finishedAt = event.finishedMinutesAgo === undefined ? at : now - event.finishedMinutesAgo * MINUTE
        updateToolCall(db, { taskId, toolUseId, state: event.state ?? ToolCallState.Done, output }, finishedAt)
      }
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

/** How a sample permission request closed, or null for one still open. */
function seedClosing(request: SeedPermissionRequest): PermissionRequestClosing | null {
  switch (request.state ?? PermissionRequestState.Open) {
    case PermissionRequestState.Open:
      return null
    case PermissionRequestState.Allowed:
      return { state: PermissionRequestState.Allowed }
    case PermissionRequestState.Denied:
      return { state: PermissionRequestState.Denied, note: request.denyNote ?? null }
    case PermissionRequestState.Withdrawn:
      return { state: PermissionRequestState.Withdrawn }
  }
}

function seedPermissionRequest(db: Database, taskId: string, request: SeedPermissionRequest, at: EpochMs): void {
  const opened = appendPermissionRequest(
    db,
    {
      taskId,
      turn: request.turn,
      toolUseId: request.toolUseId,
      agentId: request.agentId ?? null,
      toolName: request.toolName,
      input: request.input,
      title: request.title ?? null,
      displayName: request.toolName,
      description: request.description ?? null,
      suggestions: [],
      defaultToNo: request.defaultToNo ?? false,
      suppressAlwaysAllowRule: false,
    },
    at,
  )
  const closing = seedClosing(request)
  if (closing !== null) closePermissionRequest(db, opened.id, closing, at)
}

/** Writes a seed into the database as if it had been used up to `now`: the workspace open, the selected task shown. */
export function applySeed(db: Database, seed: CaptureSeed, now: EpochMs = Date.now()): void {
  db.transaction(() => {
    const workspace = createWorkspace(db, seed.workspace, now)
    setUiState(db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
    if (seed.panelTab !== undefined) setUiState(db, { key: UiStateKey.RightPanelTab, value: seed.panelTab })
    if (seed.panelWidth !== undefined) {
      setUiState(db, { key: UiStateKey.RightPanelWidth, value: String(seed.panelWidth) })
    }
    for (const [key, collapsed] of [
      [UiStateKey.SidebarCollapsed, seed.collapsed?.sidebar],
      [UiStateKey.RightPanelCollapsed, seed.collapsed?.rightPanel],
      [UiStateKey.BottomBarCollapsed, seed.collapsed?.bottomBar],
    ] as const) {
      if (collapsed !== undefined) setUiState(db, { key, value: String(collapsed) })
    }
    const resumed: string[] = []
    for (const [index, sample] of seed.tasks.entries()) {
      const at = now - sample.minutesAgo * MINUTE
      const createdAt = now - (sample.startedMinutesAgo ?? sample.minutesAgo) * MINUTE
      const newTask = {
        workspaceId: workspace.id,
        model: DEFAULT_SETTINGS.defaultModel,
        effort: DEFAULT_SETTINGS.defaultEffort,
        permissionMode: sample.permissionMode ?? DEFAULT_SETTINGS.defaultPermissionMode,
      }
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
        seedToolEvent(db, task.id, event, now, `seed-${String(index)}`)
      }
      for (const body of sample.queuedMessages ?? []) appendQueuedMessage(db, { taskId: task.id, body }, now)
      if (sample.openFiles !== undefined) {
        const { paths, activePath } = sample.openFiles
        setOpenFiles(db, { taskId: task.id, paths, activePath: activePath ?? paths[0] ?? null })
      }
      for (const { path, title, minutesAgo } of sample.artifacts ?? []) {
        const declaredAt = now - minutesAgo * MINUTE
        addArtifact(db, { taskId: task.id, path, title }, declaredAt)
        const file = join(seed.workspace.rootPath, path)
        if (existsSync(file)) utimesSync(file, new Date(declaredAt), new Date(declaredAt))
      }
      for (const request of sample.permissionRequests ?? []) {
        seedPermissionRequest(db, task.id, request, ago(request.minutesAgo))
      }
      if (sample.resumedAfterCrash === true) resumed.push(task.id)
    }
    if (resumed.length > 0) {
      setUiState(db, { key: UiStateKey.RelaunchNotice, value: serializeRelaunchNotice({ taskIds: resumed }) })
    }
  })()
}
