/**
 * The agent runner: one agent session per task, in the main process, with everything it emits saved and broadcast.
 *
 * **Session model.** Each task gets one long-lived SDK session in streaming input mode, started by its first message
 * and kept alive between turns; each message the user sends is pushed into it as the next turn. This is what
 * `docs/sdk-notes.md` recommends: the process stays warm between turns, and interrupt (Stop, P1-08) and the per-turn
 * model and effort changes only work in this mode. The task's current model and effort are applied to its session just
 * before each message is delivered, so a change made with the input bar's pickers applies from the next turn. The SDK
 * session id is saved on the task from `system/init`, so a session that's gone (the app restarted, or its process
 * failed) is started again with `resume` on the next message, or on launch if the app died mid-turn.
 *
 * **A turn**, from `send` to the SDK's `result`:
 * - The user's message goes to the chat log with the next turn number, and a turn divider to the tool log.
 * - The agent's top-level text is held back. A tool call after it makes it preamble, saved to the tool log as
 *   narration; whatever is left at the end of the turn is the final reply, saved to the chat log with the turn's
 *   summary (`./turn-summary`): the wall-clock time since the turn's first user message, and the files and lines the
 *   turn's edits changed.
 * - Each tool call is saved as running and filled in as done or error when its result arrives. A subagent's tool calls
 *   carry their `Agent` call's id.
 * - The task's activity is working for the turn, then waiting on you, or error if the turn failed.
 * - A final reply in a task you aren't viewing marks it unread (`../tasks/attention`) and is notified (`notifyReply`).
 * - The task's context usage follows the agent's latest top-level message, and its context window is what the turn's
 *   `result` reports for the session's model (`docs/sdk-notes.md`, "Usage and context size").
 *
 * **Reopen by chatting.** A message to a done task reopens it: the task goes back to active and the message is the
 * next turn of the same session, the live one if it's still running, or the saved one resumed by its id. The tool log
 * gets a marked done divider, stamped with the `doneAt` that reopening clears (the chat and header show it), at the end
 * of the last turn, then a reopened divider and the turn divider for the new turn. Marking done itself adds no divider,
 * so Undo leaves nothing behind.
 *
 * **The message queue** (`docs/decisions.md`): a message sent while the agent works waits in the task's queue, in
 * SQLite, where it can still be edited or removed, and is only handed to the session when the agent finishes its
 * current step (`docs/sdk-notes.md` §2: once pushed, the SDK can't take it back):
 * - when the running turn's top-level tool calls all have their results, the queue goes to the session, which folds it
 *   into the running turn. Each message goes to the chat log as a user message of that turn, after the one that
 *   started it and before the turn's reply, which answers them all.
 * - when a turn ends with messages still queued, they start the next turn, together.
 * - a stopped or failed turn leaves the queue alone: it stays queued until you send again, and then goes first, before
 *   what you sent. So does a turn that ends on a done task.
 * If the SDK answers a message handed to it mid-turn with a turn of its own (its result doesn't list the message), the
 * runner's turn carries on until a result does, saving each reply on the way.
 *
 * **Stop** interrupts the running turn (`docs/sdk-notes.md` §7): the SDK ends it within tens of milliseconds with an
 * aborted result, and the session stays alive for the next message. A stopped turn isn't a failure: its activity goes
 * back to waiting on you. What it already saved stays. Its held-back text, including the partial text the SDK flushes
 * when it aborts, goes to the tool log as narration rather than the chat, since it isn't a finished reply; its
 * unfinished tool calls end as errors; and a narration notes that you stopped it.
 *
 * **Errors** (`docs/design/html/16-error.html`). Glade doesn't retry a failed API request itself: Claude Code already
 * retries the transient ones with backoff, and says so before each retry (`docs/sdk-notes.md`, "Errors and retries").
 * While it does, the task's `retrying` says which retry it is, for the working line, until the agent moves on. When a
 * turn ends on an error anyway, or the session fails mid-turn, the task stops on it: its activity is error and its
 * `error` says what happened (`./error-classification` sorts it into a kind), for the chat's error card. Its held-back
 * text goes to the tool log as narration and its unfinished tool calls end as errors; an API error adds a failed "API"
 * row to the tool log, and any other error a note saying why. What the turn already saved stays.
 *
 * **Retry** runs the stopped turn again: the turn's last message goes to the session once more (started again with
 * `resume` if it's gone), optionally on another model, which becomes the task's. The chat log gets nothing new, and the
 * turn keeps its number. Starting a turn, by retrying or by sending a message, clears the error.
 *
 * **Compaction** (`docs/sdk-notes.md` §5). Compact now and ⌘⇧K (`compact`) send an idle session `/compact`, which runs
 * like a turn of its own: the agent works while it compacts, so messages sent meanwhile are queued, and Stop stops it.
 * It isn't a user turn: `/compact` never reaches the chat, there's no turn divider, and it belongs to the task's last
 * turn. The tool log gets a running Compact row at once, filled in when the SDK's `compact_boundary` reports the tokens
 * before and after; if the turn ends without one, the row ends as an error. The context usage drops to the tokens after
 * straight away (`getContextUsage()` is stale after a compaction), and follows the next assistant message from there.
 * A compaction the SDK does on its own, at its auto-compact threshold, is logged when its boundary arrives.
 *
 * **Resume on launch.** A turn the app quit or crashed in is left working in the database: a turn's user messages and
 * its working activity are saved together, so none is left unanswered. On launch, `resumeInterrupted` carries each
 * one on: it resumes the task's SDK session by its saved id (`docs/sdk-notes.md` §8), adds a resumed divider to the
 * tool log, and sends the session `RESUME_PROMPT`. A resumed session waits for a message like any other in streaming
 * input mode, so it needs one to carry on; the prompt isn't saved to the chat, since you didn't write it. The turn
 * keeps its number and ends like any other, and its queue is delivered as in any turn; its summary's duration counts
 * from its first message, before the app quit. What the dead turn had only in memory is gone: its held-back text (the
 * model still has it in its transcript) and the calls that never got a result, which end as errors. A retry the
 * turn was in is over: the working line stops saying so until the SDK retries again. Otherwise:
 * - a working task with no session id never got as far as starting its session, so the agent never saw the turn: a
 *   new session is sent the turn's messages again. With no messages there's nothing to carry on: it goes back to
 *   waiting on you, with a note.
 * - a compaction the app quit in ends as an error, and isn't redone: the task goes back to waiting on you, unless
 *   messages are queued, which start the next turn as they would have after it.
 * - a task in error, waiting on you or done has no turn running, so it's left as it is, queue and all: an error keeps
 *   its card and Retry.
 *
 * Every write is broadcast to the windows as it happens. Only the in-flight turn's bookkeeping (its held-back text and
 * running calls) is kept in memory.
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, type GladeEvent } from '../../shared/bridge'
import {
  API_TOOL_NAME,
  CompactionTrigger,
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  type ApiRetry,
  type Message,
  type QueuedMessage,
  type Task,
  type TaskError,
} from '../../shared/domain'
import { apiRowArgument, apiRowResult } from '../../shared/taskError'
import { CommandFailure } from '../bridge/errors'
import {
  emitMessageAppended,
  emitQueueChanged,
  emitToolEventAppended,
  emitToolEventUpdated,
  type Emit,
} from '../bridge/events'
import { appendMessage, lastTurn, listMessages, turnStartedAt } from '../db/repositories/messages'
import { listQueuedMessages, takeQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, listWorkingTasks } from '../db/repositories/tasks'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendToolCall,
  failRunningCompactions,
  failRunningToolCalls,
  listToolEvents,
  updateCompaction,
  updateToolCall,
} from '../db/repositories/tool-events'
import { getWorkspace } from '../db/repositories/workspaces'
import type { NotifyReply } from '../notifications/notifications'
import { addQueuedMessage } from '../tasks/queue'
import { noteAgentReply } from '../tasks/attention'
import { reopenTask, updateTaskFromRunner, updateTaskFromUser, type TaskServiceContext } from '../tasks/service'
import type { AgentBackend, AgentMcpServers, AgentSession, AgentSessionSettings } from './backend'
import { classifyAgentError } from './error-classification'
import {
  AgentEventKind,
  createSdkMessageParser,
  type AgentEvent,
  type AgentLog,
  type ApiErrorEvent,
  type ApiRetryEvent,
  type CompactedEvent,
  type TextEvent,
  type ToolCallStartedEvent,
  type ToolResultEvent,
  type TurnFinishedEvent,
} from './events'
import { systemPromptAppend } from './system-prompt'
import { summarizeTurn } from './turn-summary'

export interface AgentRunnerOptions {
  readonly db: Database
  readonly emit: Emit
  readonly backend: AgentBackend
  /** The in-process MCP servers to give a task's session, such as the Glade tools (`./glade-tools`). None by default. */
  readonly mcpServers?: (task: Task) => AgentMcpServers
  readonly log?: AgentLog
  /**
   * Notifies a final reply that arrived in a task you aren't viewing, once per reply (`../notifications`). Nothing by
   * default.
   */
  readonly notifyReply?: NotifyReply
}

export interface AgentRunner {
  /**
   * Saves the user's message and starts a turn with it. A done task is reopened first (see the module comment). Throws
   * a `CommandFailure`: `not_found` for no such task, `busy` while a turn is running.
   */
  send(taskId: string, text: string): Message
  /**
   * Adds the user's message to the task's queue, for the agent to get after its current step (see the module comment).
   * When no turn is running, the queue is delivered at once, starting one. Throws a `CommandFailure` `not_found` for no
   * such task.
   */
  queue(taskId: string, text: string): QueuedMessage
  /**
   * Stops the task's running turn, and resolves with the task once the turn has ended. Does nothing for a task whose
   * agent isn't working. Throws a `CommandFailure` `not_found` for no such task.
   */
  stop(taskId: string): Promise<Task>
  /**
   * Retries the turn an error stopped (see the module comment), on `model` if given, which becomes the task's model.
   * Answers with the task, working again. Throws a `CommandFailure`: `not_found` for no such task, `busy` while a turn
   * is running, and `invalid_transition` for a task whose agent isn't stopped by an error.
   */
  retry(taskId: string, model?: string): Task
  /**
   * Compacts the task's context now: sends its session `/compact` (see the module comment), and answers with the task,
   * now working. Throws a `CommandFailure`: `not_found` for no such task, `busy` while a turn is running, and
   * `invalid_transition` for a done task or one whose agent has no session yet.
   */
  compact(taskId: string): Task
  /**
   * Carries on the turns the app quit or crashed in (see the module comment). Call it once, on launch. Answers with the
   * ids of the tasks whose agents picked their work back up, in the order they were created.
   */
  resumeInterrupted(): string[]
  /** Closes every live session, e.g. when the app quits. */
  close(): void
}

/** The in-flight turn's bookkeeping. */
interface Turn {
  readonly number: number
  /** Top-level text since the last tool call: preamble if a tool call follows, else the final reply. */
  readonly pending: string[]
  /** The tool calls waiting on their results, with the `Agent` call each was made in (null at the top level). */
  readonly running: Map<string, string | null>
  /** The uuids of the messages handed to the session in this turn that no result has answered yet. */
  readonly awaiting: Set<string>
  /** Whether the user asked to stop the turn. */
  stopping: boolean
  /** The automatic retry of a failed API request in progress, as saved on the task; null when none is. */
  retrying: ApiRetry | null
  /** The API error the SDK gave up on, which the turn's error result follows. */
  apiError: ApiErrorEvent | null
  /** The id of the running Compact row of a compaction you asked for, until the SDK reports it; null otherwise. */
  compaction: string | null
  /** Resolves once the turn has ended, however it ended. */
  readonly ended: Promise<void>
  readonly end: () => void
}

interface LiveSession {
  readonly session: AgentSession
  turn: Turn | null
  /** The model and effort the session runs with now. */
  settings: AgentSessionSettings
  /**
   * The model the session last said it runs on (`system/init`), as the SDK names it there and in a turn's result, to
   * find its context window. Null until the first init.
   */
  sdkModel: string | null
  /** Closed by the runner: whatever it still emits is ignored, and a turn cut short stays working, for the next launch to resume. */
  closed: boolean
}

/** What the tool log says when the user stopped a turn, and what its unfinished tool calls say. */
export const STOPPED_NOTE = 'You stopped the agent.'

/** What Glade sends a session it resumed on launch, so the agent carries on with the turn the app died in. */
export const RESUME_PROMPT = 'Glade restarted while you were working. Continue where you left off.'

/** What a tool call cut off by the app quitting says. */
export const RESTARTED_TOOL_NOTE = 'Glade quit before this tool call finished.'

/** What Glade sends a session to compact it (`docs/sdk-notes.md` §5). */
export const COMPACT_COMMAND = '/compact'

/** What the tool log says for a working task that had no session to resume. */
export const NOT_RESUMED_NOTE = "Glade quit before the agent's session started, so there was nothing to resume."

/** What a tool call cut short by an error says. */
export const STOPPED_BY_ERROR_NOTE = 'The agent stopped on an error before this tool call finished.'

/** Whether a turn ended because it was interrupted: the SDK's `aborted_streaming` or `aborted_tools`. */
function isAborted(terminalReason: string | null): boolean {
  return terminalReason?.startsWith('aborted') === true
}

function newTurn(number: number): Turn {
  let end = (): void => undefined
  const ended = new Promise<void>((resolve) => {
    end = resolve
  })
  return {
    number,
    pending: [],
    running: new Map(),
    awaiting: new Set(),
    stopping: false,
    retrying: null,
    apiError: null,
    compaction: null,
    ended,
    end,
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  const { db, emit, backend } = options
  const mcpServers = options.mcpServers ?? (() => ({}))
  const log = options.log ?? console
  const notifyReply = options.notifyReply ?? (() => undefined)
  const context = { db, emit }
  const sessions = new Map<string, LiveSession>()

  const setActivity = (taskId: string, activity: TaskActivity): void => {
    if (getTask(db, taskId)?.activity !== activity) updateTaskFromRunner(context, taskId, { activity })
  }

  /**
   * The agent is working on a new turn: whatever error stopped it before is behind it, and so is any retry the app quit
   * in the middle of.
   */
  const startWorking = (taskId: string, through: TaskServiceContext = context): void => {
    const task = getTask(db, taskId)
    if (task?.activity !== TaskActivity.Working || task.error !== null || task.retrying !== null) {
      updateTaskFromRunner(through, taskId, { activity: TaskActivity.Working, error: null, retrying: null })
    }
  }

  /** A turn the app quit in is over without the agent: it waits on you, and any retry it was in is over too. */
  const backToWaiting = (taskId: string): void => {
    updateTaskFromRunner(context, taskId, { activity: TaskActivity.Waiting, retrying: null })
  }

  /** The error the turn ends on, with the retries that came before it. */
  const withRetries = (turn: Turn | null, error: Omit<TaskError, 'kind' | 'retries' | 'retryingMs'>): TaskError => {
    const retrying = turn?.retrying ?? null
    return {
      ...error,
      kind: classifyAgentError({ status: error.status, code: error.code, message: error.details }),
      retries: retrying?.attempt ?? 0,
      retryingMs: retrying === null ? 0 : Math.max(0, Date.now() - retrying.since),
    }
  }

  /** Stops the task on an error: the chat shows its card, and the task list its "Error: …" line. */
  const stopOnError = (taskId: string, error: TaskError): void => {
    updateTaskFromRunner(context, taskId, { activity: TaskActivity.Error, error, retrying: null })
  }

  /** Claude Code will retry a failed API request: the working line says so until the agent moves on. */
  const onApiRetry = (taskId: string, turn: Turn, event: ApiRetryEvent): void => {
    const since = turn.retrying?.since ?? Date.now()
    turn.retrying = { attempt: event.attempt, maxRetries: event.maxRetries, since }
    updateTaskFromRunner(context, taskId, { retrying: turn.retrying })
  }

  /** The agent moved on after a retried request: the retry is over. */
  const recovered = (taskId: string, turn: Turn): void => {
    if (turn.retrying === null) return
    turn.retrying = null
    updateTaskFromRunner(context, taskId, { retrying: null })
  }

  /** Saves the held-back text as narration, if there is any. */
  const flushPreamble = (taskId: string, turn: Turn): void => {
    const text = turn.pending.splice(0).join('\n\n').trim()
    if (text !== '') emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text }))
  }

  /** Marks the calls that never got a result as failed. */
  const failRunning = (taskId: string, turn: Turn, output: string): void => {
    for (const toolUseId of turn.running.keys()) {
      emitToolEventUpdated(emit, updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Error, output }))
    }
    turn.running.clear()
  }

  const onText = (turn: Turn, event: TextEvent): void => {
    // A subagent's own text isn't forwarded by default; if it is, it's the subagent's business, not the chat's.
    if (event.parentToolUseId === null) turn.pending.push(event.text)
  }

  const onToolCall = (taskId: string, turn: Turn, event: ToolCallStartedEvent): void => {
    flushPreamble(taskId, turn)
    const { toolUseId, name, input, parentToolUseId } = event
    emitToolEventAppended(
      emit,
      appendToolCall(db, { taskId, turn: turn.number, name, input, toolUseId, parentToolUseId }),
    )
    turn.running.set(toolUseId, parentToolUseId)
  }

  /**
   * Hands the task's queue to the session mid-turn, which folds it into the running turn (see the module comment). Each
   * message goes to the chat log as a user message of the turn.
   */
  const deliverQueue = (taskId: string, live: LiveSession, turn: Turn): void => {
    const delivered = db.transaction(() =>
      takeQueuedMessages(db, taskId).map(({ body }) =>
        appendMessage(db, { taskId, role: MessageRole.User, body, turn: turn.number }),
      ),
    )()
    if (delivered.length === 0) return
    emitQueueChanged(emit, taskId, [])
    for (const message of delivered) {
      emitMessageAppended(emit, message)
      turn.awaiting.add(message.id)
      live.session.send(message.body, message.id)
    }
  }

  /** Whether the turn's top-level tool calls all have their results: the agent has finished its current step. */
  const stepFinished = (turn: Turn): boolean => ![...turn.running.values()].includes(null)

  const onToolResult = (taskId: string, live: LiveSession, turn: Turn, event: ToolResultEvent): void => {
    const parent = turn.running.get(event.toolUseId)
    if (!turn.running.delete(event.toolUseId)) {
      log.warn(`Ignored a result for tool call ${event.toolUseId}, which isn't running`)
      return
    }
    const state = event.isError ? ToolCallState.Error : ToolCallState.Done
    // A call the SDK rejects because the user stopped the agent reads like the turn's other unfinished calls.
    const output = event.isError && turn.stopping ? STOPPED_NOTE : event.output
    const call = updateToolCall(db, { taskId, toolUseId: event.toolUseId, state, output })
    emitToolEventUpdated(emit, call)
    if (parent === null && !turn.stopping && stepFinished(turn)) deliverQueue(taskId, live, turn)
  }

  /** Forgets the session's turn, and lets whoever waits on it know it has ended. */
  const endTurn = (live: LiveSession, turn: Turn): void => {
    live.turn = null
    turn.end()
  }

  const onTurnStopped = (taskId: string, turn: Turn): void => {
    recovered(taskId, turn)
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, STOPPED_NOTE)
    emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: STOPPED_NOTE }))
    setActivity(taskId, TaskActivity.Waiting)
  }

  /** Ends the compaction you asked for as an error, if the SDK never reported it. */
  const failCompaction = (turn: Turn): void => {
    if (turn.compaction === null) return
    const id = turn.compaction
    turn.compaction = null
    emitToolEventUpdated(
      emit,
      updateCompaction(db, { id, state: ToolCallState.Error, preTokens: null, postTokens: null }),
    )
  }

  /**
   * Logs a compaction the SDK reports: fills in the one you asked for, or adds one it did on its own. The context usage
   * drops to what it reports is left.
   */
  const onCompacted = (taskId: string, turn: Turn, event: CompactedEvent): void => {
    const task = getTask(db, taskId)
    if (task === undefined) return
    const outcome = { state: ToolCallState.Done, preTokens: event.preTokens, postTokens: event.postTokens }
    if (turn.compaction === null) {
      const { trigger } = event
      const compaction = { taskId, turn: turn.number, trigger, windowTokens: task.contextWindowTokens, ...outcome }
      emitToolEventAppended(emit, appendCompaction(db, compaction))
    } else {
      emitToolEventUpdated(emit, updateCompaction(db, { id: turn.compaction, ...outcome }))
      turn.compaction = null
    }
    if (event.postTokens !== null && task.contextUsedTokens !== event.postTokens) {
      updateTaskFromRunner(context, taskId, { contextUsedTokens: event.postTokens })
    }
  }

  const onTurnFinished = (taskId: string, live: LiveSession, turn: Turn, event: TurnFinishedEvent): void => {
    failCompaction(turn)
    if (event.isError && (turn.stopping || isAborted(event.terminalReason))) {
      endTurn(live, turn)
      onTurnStopped(taskId, turn)
      return
    }
    if (event.isError) {
      endTurn(live, turn)
      onTurnFailed(taskId, turn, event)
      return
    }
    recovered(taskId, turn)
    const held = turn.pending.splice(0).join('\n\n').trim()
    const reply = held === '' ? event.result.trim() : held
    if (reply !== '') {
      const turnEvents = listToolEvents(db, taskId).filter((toolEvent) => toolEvent.turn === turn.number)
      const finishedAt = Date.now()
      const span = { startedAt: turnStartedAt(db, taskId, turn.number), finishedAt }
      const summary = summarizeTurn(span, turnEvents)
      const message = appendMessage(
        db,
        { taskId, role: MessageRole.Agent, body: reply, turn: turn.number, summary },
        finishedAt,
      )
      emitMessageAppended(emit, message)
      if (noteAgentReply(context, taskId)) notifyReply(taskId, reply)
    }
    failRunning(taskId, turn, 'The turn ended before this tool call finished.')
    // A message handed over mid-turn that this result didn't answer gets a turn of its own from the SDK: wait for it.
    // Only when the result names at least one of the turn's messages, though: one that names none can't be matched up.
    const answered = event.userMessageUuids ?? []
    if (answered.some((uuid) => turn.awaiting.has(uuid))) {
      for (const uuid of answered) turn.awaiting.delete(uuid)
      if (turn.awaiting.size > 0) return
    }
    endTurn(live, turn)
    const task = getTask(db, taskId)
    if (task?.state === TaskState.Active && listQueuedMessages(db, taskId).length > 0) {
      startTurn(task, live, null)
      return
    }
    setActivity(taskId, TaskActivity.Waiting)
  }

  /**
   * The turn ended on an error (see the module comment). An API error gets a failed API row in the tool log; any other
   * gets a note saying why.
   */
  const onTurnFailed = (taskId: string, turn: Turn, event: TurnFinishedEvent): void => {
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, STOPPED_BY_ERROR_NOTE)
    const { apiError } = turn
    const reported = event.errors.join('\n')
    const isApiError = apiError !== null || event.apiErrorStatus !== null || event.terminalReason === 'api_error'
    if (!isApiError) {
      const details = reported === '' ? `The turn failed (${event.terminalReason ?? 'unknown'}).` : reported
      emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: details }))
      stopOnError(taskId, withRetries(turn, { source: TaskErrorSource.Turn, status: null, code: null, details }))
      return
    }
    const details = [apiError?.message ?? '', event.result, reported].find((text) => text.trim() !== '') ?? ''
    const error = withRetries(turn, {
      source: TaskErrorSource.Api,
      status: event.apiErrorStatus,
      code: apiError?.code ?? null,
      details: details === '' ? `The API request failed (${event.terminalReason ?? 'unknown'}).` : details,
    })
    const toolUseId = `glade-api-error-${randomUUID()}`
    const input = { request: apiRowArgument(error) }
    appendToolCall(db, { taskId, turn: turn.number, name: API_TOOL_NAME, input, toolUseId, parentToolUseId: null })
    const output = `${apiRowResult(error)}\n\n${error.details}`
    emitToolEventAppended(emit, updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Error, output }))
    stopOnError(taskId, error)
  }

  /** Keeps the context window the result reports for the session's model, if it reports one. */
  const recordContextWindow = (taskId: string, live: LiveSession, event: TurnFinishedEvent): void => {
    const window = live.sdkModel === null ? undefined : event.contextWindows[live.sdkModel]
    if (window !== undefined && getTask(db, taskId)?.contextWindowTokens !== window) {
      updateTaskFromRunner(context, taskId, { contextWindowTokens: window })
    }
  }

  /** The session is gone: fail its turn, if one was running, and forget it so the next message starts it again. */
  const onSessionFailed = (taskId: string, live: LiveSession, message: string): void => {
    if (sessions.get(taskId) === live) sessions.delete(taskId)
    const { turn } = live
    if (turn === null) return
    endTurn(live, turn)
    failCompaction(turn)
    turn.pending.push(message)
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, message)
    stopOnError(
      taskId,
      withRetries(turn, { source: TaskErrorSource.Session, status: null, code: null, details: message }),
    )
  }

  const onEvent = (taskId: string, live: LiveSession, event: AgentEvent): void => {
    if (live.closed) return
    if (event.kind === AgentEventKind.SessionStarted) {
      live.sdkModel = event.model
      if (getTask(db, taskId)?.sessionId !== event.sessionId) {
        updateTaskFromRunner(context, taskId, { sessionId: event.sessionId })
      }
      return
    }
    if (event.kind === AgentEventKind.SessionFailed) {
      onSessionFailed(taskId, live, event.message)
      return
    }
    const { turn } = live
    // Between turns there's nothing to add to: e.g. a late system message after a turn's result.
    if (turn === null) return
    switch (event.kind) {
      case AgentEventKind.Text:
        recovered(taskId, turn)
        onText(turn, event)
        return
      case AgentEventKind.ToolCallStarted:
        recovered(taskId, turn)
        onToolCall(taskId, turn, event)
        return
      case AgentEventKind.ToolResult:
        onToolResult(taskId, live, turn, event)
        return
      case AgentEventKind.ApiRetry:
        onApiRetry(taskId, turn, event)
        return
      case AgentEventKind.ApiError:
        turn.apiError = event
        return
      case AgentEventKind.ContextUsed:
        recovered(taskId, turn)
        if (getTask(db, taskId)?.contextUsedTokens !== event.tokens) {
          updateTaskFromRunner(context, taskId, { contextUsedTokens: event.tokens })
        }
        return
      case AgentEventKind.Compacted:
        onCompacted(taskId, turn, event)
        return
      case AgentEventKind.TurnFinished:
        recordContextWindow(taskId, live, event)
        onTurnFinished(taskId, live, turn, event)
        return
    }
  }

  /** Reads the session's messages for its whole life, handling each as it arrives. */
  const pump = async (taskId: string, live: LiveSession): Promise<void> => {
    const parse = createSdkMessageParser(log)
    const handle = (event: AgentEvent): void => {
      try {
        onEvent(taskId, live, event)
      } catch (error) {
        log.warn(`Failed to handle an agent event for task ${taskId}`, error)
      }
    }
    try {
      for await (const raw of live.session.messages) {
        for (const event of parse(raw)) handle(event)
      }
      handle({ kind: AgentEventKind.SessionFailed, message: 'The agent session ended unexpectedly.' })
    } catch (error) {
      handle({ kind: AgentEventKind.SessionFailed, message: `The agent stopped: ${describeError(error)}` })
    }
  }

  const start = (task: Task): LiveSession => {
    const workspace = getWorkspace(db, task.workspaceId)
    if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${task.workspaceId}`)
    const session = backend.start({
      cwd: workspace.rootPath,
      model: task.model,
      effort: task.effort,
      resumeSessionId: task.sessionId,
      systemPromptAppend: systemPromptAppend(task),
      mcpServers: mcpServers(task),
    })
    const live: LiveSession = {
      session,
      turn: null,
      settings: { model: task.model, effort: task.effort },
      sdkModel: null,
      closed: false,
    }
    sessions.set(task.id, live)
    void pump(task.id, live)
    return live
  }

  /**
   * Carries on the turn a working task was in when the app quit (see the module comment). Answers whether the task's
   * agent picked its work back up.
   */
  const resume = (task: Task): boolean => {
    const taskId = task.id
    // A task always has a turn by the time it works; the tool log's first turn is 1 regardless.
    const turn = Math.max(1, lastTurn(db, taskId))
    for (const call of failRunningToolCalls(db, taskId, RESTARTED_TOOL_NOTE)) emitToolEventUpdated(emit, call)
    const compactions = failRunningCompactions(db, taskId)
    for (const compaction of compactions) emitToolEventUpdated(emit, compaction)
    // The turn was a compaction you asked for, not a turn of yours: it ends there, and the queue starts the next turn,
    // as it would have when the compaction finished.
    if (compactions.length > 0) {
      if (listQueuedMessages(db, taskId).length > 0) {
        startTurn(task, start(task), null)
        return true
      }
      backToWaiting(taskId)
      return false
    }
    if (task.sessionId !== null) {
      const live = start(task)
      startWorking(taskId)
      emitToolEventAppended(emit, appendDivider(db, { taskId, turn, dividerKind: DividerKind.Resumed }))
      const uuid = randomUUID()
      live.turn = newTurn(turn)
      live.turn.awaiting.add(uuid)
      live.session.send(RESUME_PROMPT, uuid)
      return true
    }
    // The session never started, so the agent never saw the turn's messages: a new session gets them again.
    const unanswered = listMessages(db, taskId).filter(
      (message) => message.turn === turn && message.role === MessageRole.User,
    )
    if (unanswered.length === 0) {
      emitToolEventAppended(emit, appendNarration(db, { taskId, turn, text: NOT_RESUMED_NOTE }))
      backToWaiting(taskId)
      return false
    }
    const live = start(task)
    startWorking(taskId)
    emitToolEventAppended(emit, appendDivider(db, { taskId, turn, dividerKind: DividerKind.Resumed }))
    live.turn = newTurn(turn)
    for (const message of unanswered) {
      live.turn.awaiting.add(message.id)
      live.session.send(message.body, message.id)
    }
    return true
  }

  /** The pickers change the task, not the session: its current model and effort apply from the next turn on. */
  const applySettings = (task: Task, live: LiveSession): void => {
    if (live.settings.model !== task.model || live.settings.effort !== task.effort) {
      live.settings = { model: task.model, effort: task.effort }
      live.session.configure(live.settings)
    }
  }

  /**
   * Starts a turn with the task's queued messages, in order, then `text` if there is one: each is saved to the chat log
   * as a user message of the new turn and handed to the session. A done task is reopened first (see the module
   * comment). Answers with the messages, in order.
   */
  const startTurn = (task: Task, live: LiveSession, text: string | null): Message[] => {
    const taskId = task.id
    applySettings(task, live)

    const turn = lastTurn(db, taskId) + 1
    const reopening = task.state === TaskState.Done
    // The task's own events wait for the transaction to commit, so the windows never hear of a change that didn't.
    const reopenEvents: GladeEvent[] = []
    const workingEvents: GladeEvent[] = []
    const { queued, messages, dividers } = db.transaction(() => {
      // Reopening clears `doneAt`, so the marked done divider keeps it: it's the time the chat and header show.
      const markedDone = reopening
        ? [
            appendDivider(
              db,
              { taskId, turn: turn - 1, dividerKind: DividerKind.MarkedDone },
              task.doneAt ?? task.updatedAt,
            ),
          ]
        : []
      if (reopening) reopenTask({ db, emit: (event) => reopenEvents.push(event) }, taskId)
      const queued = takeQueuedMessages(db, taskId)
      const bodies = [...queued.map(({ body }) => body), ...(text === null ? [] : [text])]
      const messages = bodies.map((body) => appendMessage(db, { taskId, role: MessageRole.User, body, turn }))
      const reopened = reopening ? [appendDivider(db, { taskId, turn, dividerKind: DividerKind.Reopened })] : []
      const divider = appendDivider(db, { taskId, turn, dividerKind: DividerKind.Turn })
      // Working in the same write as the turn's messages: if the app dies before the session gets them, the next
      // launch finds the turn working and carries it on (see `resume`), rather than a message nobody answers.
      startWorking(taskId, { db, emit: (event) => workingEvents.push(event) })
      return { queued, messages, dividers: [...markedDone, ...reopened, divider] }
    })()
    for (const event of reopenEvents) emit(event)
    if (queued.length > 0) emitQueueChanged(emit, taskId, [])
    for (const message of messages) emitMessageAppended(emit, message)
    for (const divider of dividers) emitToolEventAppended(emit, divider)
    for (const event of workingEvents) emit(event)

    live.turn = newTurn(turn)
    for (const message of messages) {
      live.turn.awaiting.add(message.id)
      live.session.send(message.body, message.id)
    }
    return messages
  }

  return {
    send(taskId, text) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      if ((sessions.get(taskId)?.turn ?? null) !== null) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; queue the message instead')
      }
      // The message sent is the last of the turn's: any queued ones go before it.
      const message = startTurn(task, sessions.get(taskId) ?? start(task), text).at(-1)
      if (message === undefined) throw new Error(`The turn for task ${taskId} started without its message`)
      return message
    },

    queue(taskId, text) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const queued = addQueuedMessage(context, taskId, text)
      const live = sessions.get(taskId)
      // The turn ended just before the message arrived: nothing will deliver the queue, so it starts a turn now.
      if ((live?.turn ?? null) === null) startTurn(task, live ?? start(task), null)
      return queued
    },

    async stop(taskId) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const live = sessions.get(taskId)
      const turn = live?.turn ?? null
      if (live === undefined || turn === null) return task
      turn.stopping = true
      await live.session.interrupt()
      await turn.ended
      return getTask(db, taskId) ?? task
    },

    retry(taskId, model) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      if ((sessions.get(taskId)?.turn ?? null) !== null) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working')
      }
      const last = listMessages(db, taskId).findLast((message) => message.role === MessageRole.User)
      if (task.state !== TaskState.Active || task.activity !== TaskActivity.Error || last === undefined) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, "The agent isn't stopped by an error")
      }
      const current = model === undefined ? task : updateTaskFromUser(context, taskId, { model })
      const live = sessions.get(taskId) ?? start(current)
      applySettings(current, live)
      startWorking(taskId)
      // The same turn again: its last message goes to the session once more, and the chat log stays as it is.
      const uuid = randomUUID()
      live.turn = newTurn(last.turn)
      live.turn.awaiting.add(uuid)
      live.session.send(last.body, uuid)
      return getTask(db, taskId) ?? current
    },

    compact(taskId) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const running = sessions.get(taskId)
      if ((running?.turn ?? null) !== null) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; compact once it has finished')
      }
      if (task.state === TaskState.Done) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'A done task is not compacted')
      }
      if (task.sessionId === null) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'The agent has no context to compact yet')
      }
      const live = running ?? start(task)
      const turn = Math.max(1, lastTurn(db, taskId))
      const compaction = appendCompaction(db, {
        taskId,
        turn,
        trigger: CompactionTrigger.Manual,
        state: ToolCallState.Running,
        preTokens: null,
        postTokens: null,
        windowTokens: task.contextWindowTokens,
      })
      emitToolEventAppended(emit, compaction)
      setActivity(taskId, TaskActivity.Working)
      live.turn = newTurn(turn)
      live.turn.compaction = compaction.id
      const uuid = randomUUID()
      live.turn.awaiting.add(uuid)
      live.session.send(COMPACT_COMMAND, uuid)
      return getTask(db, taskId) ?? task
    },

    resumeInterrupted() {
      const resumed: string[] = []
      for (const task of listWorkingTasks(db)) {
        try {
          if (resume(task)) resumed.push(task.id)
        } catch (error) {
          log.warn(`Failed to resume task ${task.id}`, error)
          const text = `Glade couldn't resume the agent: ${describeError(error)}`
          emitToolEventAppended(
            emit,
            appendNarration(db, { taskId: task.id, turn: Math.max(1, lastTurn(db, task.id)), text }),
          )
          const failure = { source: TaskErrorSource.Session, status: null, code: null, details: text }
          stopOnError(task.id, withRetries(null, failure))
        }
      }
      return resumed
    },

    close() {
      for (const live of sessions.values()) {
        live.closed = true
        live.session.close()
        live.turn?.end()
      }
      sessions.clear()
    },
  }
}
