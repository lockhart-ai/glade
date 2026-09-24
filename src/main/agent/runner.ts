/**
 * The agent runner: one agent session per task, in the main process, with everything it emits saved and broadcast.
 *
 * **Session model.** Each task gets one long-lived SDK session in streaming input mode, started by its first message
 * and kept alive between turns; each message the user sends is pushed into it as the next turn. This is what
 * `docs/sdk-notes.md` recommends: the process stays warm between turns, and interrupt (Stop, P1-08) and the per-turn
 * model and effort changes (P1-13) only work in this mode. The SDK session id is saved on the task from `system/init`,
 * so a session that's gone (the app restarted, or its process failed) is started again with `resume` on the next
 * message, and P1-17 can resume it on launch.
 *
 * **A turn**, from `send` to the SDK's `result`:
 * - The user's message goes to the chat log with the next turn number, and a turn divider to the tool log.
 * - The agent's top-level text is held back. A tool call after it makes it preamble, saved to the tool log as
 *   narration; whatever is left at the end of the turn is the final reply, saved to the chat log.
 * - Each tool call is saved as running and filled in as done or error when its result arrives. A subagent's tool calls
 *   carry their `Agent` call's id.
 * - The task's activity is working for the turn, then waiting on you, or error if the turn failed.
 *
 * Every write is broadcast to the windows as it happens. Only the in-flight turn's bookkeeping (its held-back text and
 * running calls) is kept in memory; P1-17 recovers a turn the app died in from the database.
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  type Message,
  type Task,
} from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { emitMessageAppended, emitToolEventAppended, emitToolEventUpdated, type Emit } from '../bridge/events'
import { appendMessage, lastTurn } from '../db/repositories/messages'
import { getTask } from '../db/repositories/tasks'
import { appendDivider, appendNarration, appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { getWorkspace } from '../db/repositories/workspaces'
import { updateTaskFromRunner } from '../tasks/service'
import type { AgentBackend, AgentMcpServers, AgentSession } from './backend'
import {
  AgentEventKind,
  createSdkMessageParser,
  type AgentEvent,
  type AgentLog,
  type TextEvent,
  type ToolCallStartedEvent,
  type ToolResultEvent,
  type TurnFinishedEvent,
} from './events'

export interface AgentRunnerOptions {
  readonly db: Database
  readonly emit: Emit
  readonly backend: AgentBackend
  /** The in-process MCP servers to give a task's session. The seam for the Glade tools (P1-09). None by default. */
  readonly mcpServers?: (task: Task) => AgentMcpServers
  readonly log?: AgentLog
}

export interface AgentRunner {
  /**
   * Saves the user's message and starts a turn with it. Throws a `CommandFailure`: `not_found` for no such task,
   * `invalid_transition` for a done task, `busy` while a turn is running.
   */
  send(taskId: string, text: string): Message
  /** Interrupts the task's running turn, if it has a live session. The seam for Stop (P1-08). */
  interrupt(taskId: string): Promise<void>
  /** Closes every live session, e.g. when the app quits. */
  close(): void
}

/** The in-flight turn's bookkeeping. */
interface Turn {
  readonly number: number
  /** Top-level text since the last tool call: preamble if a tool call follows, else the final reply. */
  readonly pending: string[]
  /** The tool calls waiting on their results. */
  readonly running: Set<string>
}

interface LiveSession {
  readonly session: AgentSession
  turn: Turn | null
  /** Closed by the runner: whatever it still emits is ignored, and a turn cut short stays working for P1-17. */
  closed: boolean
}

/** Appended to Claude Code's system prompt: which task this is and where it runs. */
export function systemPromptAppend(task: Task): string {
  const title = task.title === '' ? 'not set yet' : `"${task.title}"`
  return [
    'You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.',
    'This session is one Glade task, with one objective.',
    `Its task id is ${task.id}. Its title is ${title}.`,
  ].join('\n')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  const { db, emit, backend } = options
  const mcpServers = options.mcpServers ?? (() => ({}))
  const log = options.log ?? console
  const context = { db, emit }
  const sessions = new Map<string, LiveSession>()

  const setActivity = (taskId: string, activity: TaskActivity): void => {
    if (getTask(db, taskId)?.activity !== activity) updateTaskFromRunner(context, taskId, { activity })
  }

  /** Saves the held-back text as narration, if there is any. */
  const flushPreamble = (taskId: string, turn: Turn): void => {
    const text = turn.pending.splice(0).join('\n\n').trim()
    if (text !== '') emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text }))
  }

  /** Marks the calls that never got a result as failed. */
  const failRunning = (taskId: string, turn: Turn, output: string): void => {
    for (const toolUseId of turn.running) {
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
    turn.running.add(toolUseId)
  }

  const onToolResult = (taskId: string, turn: Turn, event: ToolResultEvent): void => {
    if (!turn.running.delete(event.toolUseId)) {
      log.warn(`Ignored a result for tool call ${event.toolUseId}, which isn't running`)
      return
    }
    const state = event.isError ? ToolCallState.Error : ToolCallState.Done
    const call = updateToolCall(db, { taskId, toolUseId: event.toolUseId, state, output: event.output })
    emitToolEventUpdated(emit, call)
  }

  const onTurnFinished = (taskId: string, live: LiveSession, turn: Turn, event: TurnFinishedEvent): void => {
    live.turn = null
    if (event.isError) {
      const why =
        event.errors.length > 0 ? event.errors.join('\n') : `The turn failed (${event.terminalReason ?? 'unknown'}).`
      turn.pending.push(why)
      flushPreamble(taskId, turn)
      failRunning(taskId, turn, why)
      setActivity(taskId, TaskActivity.Error)
      return
    }
    const held = turn.pending.join('\n\n').trim()
    const reply = held === '' ? event.result.trim() : held
    if (reply !== '') {
      const message = appendMessage(db, { taskId, role: MessageRole.Agent, body: reply, turn: turn.number })
      emitMessageAppended(emit, message)
    }
    failRunning(taskId, turn, 'The turn ended before this tool call finished.')
    setActivity(taskId, TaskActivity.Waiting)
  }

  /** The session is gone: fail its turn, if one was running, and forget it so the next message starts it again. */
  const onSessionFailed = (taskId: string, live: LiveSession, message: string): void => {
    if (sessions.get(taskId) === live) sessions.delete(taskId)
    const { turn } = live
    live.turn = null
    if (turn === null) return
    turn.pending.push(message)
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, message)
    setActivity(taskId, TaskActivity.Error)
  }

  const onEvent = (taskId: string, live: LiveSession, event: AgentEvent): void => {
    if (live.closed) return
    if (event.kind === AgentEventKind.SessionStarted) {
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
        onText(turn, event)
        return
      case AgentEventKind.ToolCallStarted:
        onToolCall(taskId, turn, event)
        return
      case AgentEventKind.ToolResult:
        onToolResult(taskId, turn, event)
        return
      case AgentEventKind.TurnFinished:
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
    const live: LiveSession = { session, turn: null, closed: false }
    sessions.set(task.id, live)
    void pump(task.id, live)
    return live
  }

  return {
    send(taskId, text) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      if (task.state === TaskState.Done) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, "Can't send a message to a task that is done")
      }
      if ((sessions.get(taskId)?.turn ?? null) !== null) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; wait for it to finish its turn')
      }
      const live = sessions.get(taskId) ?? start(task)

      const turn = lastTurn(db, taskId) + 1
      const { message, divider } = db.transaction(() => ({
        message: appendMessage(db, { taskId, role: MessageRole.User, body: text, turn }),
        divider: appendDivider(db, { taskId, turn, dividerKind: DividerKind.Turn }),
      }))()
      emitMessageAppended(emit, message)
      emitToolEventAppended(emit, divider)
      setActivity(taskId, TaskActivity.Working)

      live.turn = { number: turn, pending: [], running: new Set() }
      live.session.send(text, message.id)
      return message
    },

    async interrupt(taskId) {
      await sessions.get(taskId)?.session.interrupt()
    },

    close() {
      for (const live of sessions.values()) {
        live.closed = true
        live.session.close()
      }
      sessions.clear()
    },
  }
}
