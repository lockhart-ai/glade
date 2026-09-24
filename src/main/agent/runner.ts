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
 *   summary (`./turn-summary`): the duration the `result` reports, and the files and lines the turn's edits changed.
 * - Each tool call is saved as running and filled in as done or error when its result arrives. A subagent's tool calls
 *   carry their `Agent` call's id.
 * - The task's activity is working for the turn, then waiting on you, or error if the turn failed.
 * - A final reply in a task you aren't viewing marks it unread (`../tasks/attention`).
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
 * **Resume on launch.** A turn the app quit or crashed in is left working in the database. On launch,
 * `resumeInterrupted` carries each one on: it resumes the task's SDK session by its saved id (`docs/sdk-notes.md` §8),
 * adds a resumed divider to the tool log, and sends the session `RESUME_PROMPT`. A resumed session waits for a message
 * like any other in streaming input mode, so it needs one to carry on; the prompt isn't saved to the chat, since you
 * didn't write it. The turn keeps its number and ends like any other. What the dead turn had only in memory is gone:
 * its held-back text (the model still has it in its transcript) and the calls that never got a result, which end as
 * errors. A working task with no session id never got as far as starting its session, so there's nothing to resume:
 * it goes back to waiting on you, with a note.
 *
 * Every write is broadcast to the windows as it happens. Only the in-flight turn's bookkeeping (its held-back text and
 * running calls) is kept in memory.
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, type GladeEvent } from '../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  type Message,
  type QueuedMessage,
  type Task,
} from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import {
  emitMessageAppended,
  emitQueueChanged,
  emitToolEventAppended,
  emitToolEventUpdated,
  type Emit,
} from '../bridge/events'
import { appendMessage, lastTurn } from '../db/repositories/messages'
import { listQueuedMessages, takeQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, listWorkingTasks } from '../db/repositories/tasks'
import {
  appendDivider,
  appendNarration,
  appendToolCall,
  failRunningToolCalls,
  listToolEvents,
  updateToolCall,
} from '../db/repositories/tool-events'
import { getWorkspace } from '../db/repositories/workspaces'
import { addQueuedMessage } from '../tasks/queue'
import { noteAgentReply } from '../tasks/attention'
import { reopenTask, updateTaskFromRunner } from '../tasks/service'
import type { AgentBackend, AgentMcpServers, AgentSession, AgentSessionSettings } from './backend'
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
import { systemPromptAppend } from './system-prompt'
import { summarizeTurn } from './turn-summary'

export interface AgentRunnerOptions {
  readonly db: Database
  readonly emit: Emit
  readonly backend: AgentBackend
  /** The in-process MCP servers to give a task's session, such as the Glade tools (`./glade-tools`). None by default. */
  readonly mcpServers?: (task: Task) => AgentMcpServers
  readonly log?: AgentLog
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
  /** Carries on the turns the app quit or crashed in (see the module comment). Call it once, on launch. */
  resumeInterrupted(): void
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

/** What the tool log says for a working task that had no session to resume. */
export const NOT_RESUMED_NOTE = "Glade quit before the agent's session started, so there was nothing to resume."

/** Whether a turn ended because it was interrupted: the SDK's `aborted_streaming` or `aborted_tools`. */
function isAborted(terminalReason: string | null): boolean {
  return terminalReason?.startsWith('aborted') === true
}

function newTurn(number: number): Turn {
  let end = (): void => undefined
  const ended = new Promise<void>((resolve) => {
    end = resolve
  })
  return { number, pending: [], running: new Map(), awaiting: new Set(), stopping: false, ended, end }
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
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, STOPPED_NOTE)
    emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: STOPPED_NOTE }))
    setActivity(taskId, TaskActivity.Waiting)
  }

  const onTurnFinished = (taskId: string, live: LiveSession, turn: Turn, event: TurnFinishedEvent): void => {
    if (event.isError && (turn.stopping || isAborted(event.terminalReason))) {
      endTurn(live, turn)
      onTurnStopped(taskId, turn)
      return
    }
    if (event.isError) {
      endTurn(live, turn)
      const why =
        event.errors.length > 0 ? event.errors.join('\n') : `The turn failed (${event.terminalReason ?? 'unknown'}).`
      turn.pending.push(why)
      flushPreamble(taskId, turn)
      failRunning(taskId, turn, why)
      setActivity(taskId, TaskActivity.Error)
      return
    }
    const held = turn.pending.splice(0).join('\n\n').trim()
    const reply = held === '' ? event.result.trim() : held
    if (reply !== '') {
      const turnEvents = listToolEvents(db, taskId).filter((toolEvent) => toolEvent.turn === turn.number)
      const summary = summarizeTurn(event.durationMs, turnEvents)
      const message = appendMessage(db, { taskId, role: MessageRole.Agent, body: reply, turn: turn.number, summary })
      emitMessageAppended(emit, message)
      noteAgentReply(context, taskId)
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
    turn.pending.push(message)
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, message)
    setActivity(taskId, TaskActivity.Error)
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
        onText(turn, event)
        return
      case AgentEventKind.ToolCallStarted:
        onToolCall(taskId, turn, event)
        return
      case AgentEventKind.ToolResult:
        onToolResult(taskId, live, turn, event)
        return
      case AgentEventKind.ContextUsed:
        if (getTask(db, taskId)?.contextUsedTokens !== event.tokens) {
          updateTaskFromRunner(context, taskId, { contextUsedTokens: event.tokens })
        }
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

  /** Carries on the turn a working task was in when the app quit (see the module comment). */
  const resume = (task: Task): void => {
    const turn = lastTurn(db, task.id)
    for (const call of failRunningToolCalls(db, task.id, RESTARTED_TOOL_NOTE)) emitToolEventUpdated(emit, call)
    if (task.sessionId === null) {
      emitToolEventAppended(emit, appendNarration(db, { taskId: task.id, turn, text: NOT_RESUMED_NOTE }))
      setActivity(task.id, TaskActivity.Waiting)
      return
    }
    const live = start(task)
    emitToolEventAppended(emit, appendDivider(db, { taskId: task.id, turn, dividerKind: DividerKind.Resumed }))
    const uuid = randomUUID()
    live.turn = newTurn(turn)
    live.turn.awaiting.add(uuid)
    live.session.send(RESUME_PROMPT, uuid)
  }

  /**
   * Starts a turn with the task's queued messages, in order, then `text` if there is one: each is saved to the chat log
   * as a user message of the new turn and handed to the session. A done task is reopened first (see the module
   * comment). Answers with the messages, in order.
   */
  const startTurn = (task: Task, live: LiveSession, text: string | null): Message[] => {
    const taskId = task.id
    // The pickers change the task, not the session: its current model and effort apply from this turn on.
    if (live.settings.model !== task.model || live.settings.effort !== task.effort) {
      live.settings = { model: task.model, effort: task.effort }
      live.session.configure(live.settings)
    }

    const turn = lastTurn(db, taskId) + 1
    const reopening = task.state === TaskState.Done
    // Reopening's own events wait for the transaction to commit, so the windows never hear of a reopen that didn't.
    const reopenEvents: GladeEvent[] = []
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
      return { queued, messages, dividers: [...markedDone, ...reopened, divider] }
    })()
    for (const event of reopenEvents) emit(event)
    if (queued.length > 0) emitQueueChanged(emit, taskId, [])
    for (const message of messages) emitMessageAppended(emit, message)
    for (const divider of dividers) emitToolEventAppended(emit, divider)
    setActivity(taskId, TaskActivity.Working)

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

    resumeInterrupted() {
      for (const task of listWorkingTasks(db)) {
        try {
          resume(task)
        } catch (error) {
          log.warn(`Failed to resume task ${task.id}`, error)
          const text = `Glade couldn't resume the agent: ${describeError(error)}`
          emitToolEventAppended(emit, appendNarration(db, { taskId: task.id, turn: lastTurn(db, task.id), text }))
          setActivity(task.id, TaskActivity.Error)
        }
      }
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
