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
 *   carry their `Agent` call's id. A subagent's own text (`forwardSubagentText`) isn't held back: it goes straight to
 *   the tool log as narration carrying its `Agent` call's id, for the Subagents tab, and never to the chat.
 * - The task's activity is working for the turn, then waiting on you, or error if the turn failed.
 * - A final reply in a task you aren't viewing marks it unread (`../tasks/attention`) and is notified (`notifyReply`).
 * - The task's context usage follows the agent's latest top-level message, and its context window is what the turn's
 *   `result` reports for the session's model (`docs/sdk-notes.md`, "Usage and context size").
 *
 * **Turns the agent starts itself.** The SDK starts a turn with no message from you when a background command or
 * subagent finishes, a `Monitor` reports an event or ends, or a `ScheduleWakeup` or `CronCreate` job fires: the SDK's
 * own tools the agent schedules its follow-ups with, which Glade leaves to it (`docs/sdk-notes.md`, "Turns the agent
 * starts itself" and §11). When the agent's own text, tool call or context usage (or an API error in their place) arrives between
 * turns, the runner opens the task's next turn for it (`openTurn`): a turn divider and the working activity, with no
 * message in the chat until it replies. From there it's a turn like any other: its final reply, with a summary timed
 * from its divider, unread marker and notification; the queue delivered into it and after it; Stop; and a relaunch
 * carrying it on. As with any new turn, an error or pause the task had is behind it; a done task stays done while it
 * runs. Anything else between turns (a late system message after a result, a foreground subagent's messages) is still
 * ignored.
 *
 * **Background subagents** (`docs/sdk-notes.md`, "Background subagents"). An `Agent` call with `run_in_background`
 * returns as soon as its subagent is launched, and the turn carries on and ends without waiting for it, so the task goes
 * back to waiting on you and takes messages while the subagent works. The subagent isn't done then: its `Agent` call's
 * row keeps running, for the Subagents tab, until the SDK's task notification says it ended, when it's done, or failed
 * (a stopped one fails, as a stopped turn's calls do). Its calls and notes are logged as they arrive, whether a turn is
 * running or not, with the turn its `Agent` call was made in; they never open a turn, and a turn ending doesn't cut
 * them off. Stop subagent stops it by the SDK's task id, as a foreground one. The agent then usually starts a turn of
 * its own to report on it (above). A background subagent dies with its session: if the session fails, it fails with it,
 * and if the app quits, its calls end as interrupted on the next launch.
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
 * **Pauses** (`docs/design/html/17-usage-limit.html`, `./pauses`). A turn that ends on the account's usage limit, or
 * because the API can't be reached, doesn't stop the task on an error: the task pauses, its activity paused and its
 * `pause` saying why and when it resumes, for the app-wide banner, the task list and the chat's paused line. Its
 * held-back text goes to the tool log as narration and its unfinished tool calls end as errors, as for an error, but
 * the tool log gets no failed API row. Messages sent meanwhile wait in the queue. The pause resumes on its own: at the
 * limit's reset time (from the SDK's `rate_limit_event`), or once the network is back (`isOnline`), with a timer that a
 * relaunch arms again. Resuming is a retry (below), and the queue follows once the turn ends. Retrying a paused task
 * yourself, e.g. on another model, resumes it at once.
 *
 * **Retry** runs the stopped turn again: the turn's last message goes to the session once more (started again with
 * `resume` if it's gone), optionally on another model, which becomes the task's. The chat log gets nothing new, and the
 * turn keeps its number. Starting a turn, by retrying or by sending a message, clears the error or pause.
 *
 * **Compaction** (`docs/sdk-notes.md` §5). Compact now and ⌘⇧K (`compact`) send an idle session `/compact`, which runs
 * like a turn of its own: the agent works while it compacts, so messages sent meanwhile are queued, and Stop stops it.
 * It isn't a user turn: `/compact` never reaches the chat, there's no turn divider, and it belongs to the task's last
 * turn. The tool log gets a running Compact row at once, filled in when the SDK's `compact_boundary` reports the tokens
 * before and after; if the turn ends without one, the row ends as an error. The context usage drops to the tokens after
 * straight away (`getContextUsage()` is stale after a compaction), and follows the next assistant message from there.
 * A compaction the SDK does on its own, at its auto-compact threshold in the middle of a turn, gets a running Compact
 * row (automatic) when the SDK says it's compacting, filled in the same way; the turn then carries on to its reply. A
 * compaction the SDK says failed ends its row as an error straight away.
 *
 * **Questions** (`ask`, `../questions/questions`). The agent's `ask` call blocks its turn until you answer. Meanwhile
 * the task waits on you (its activity is waiting, and `asking` is true), though its turn is still running:
 * - `answer` answers with the card: the answers are checked against the questions, and the call returns them.
 * - Sending a message answers in your own words: it goes to the chat log as your reply, in the turn that asked, and the
 *   call returns it as `{ freeText }`. It starts no turn and isn't queued, since the turn it would wait for is waiting
 *   on it. A message queued before the question opened stays queued until the call returns.
 * - A turn that ends some other way (stopped, failed, its session gone) withdraws the question; Stop withdraws it
 *   first, so the call isn't left holding the turn up.
 * If the app quits with a question open, its call and turn are gone, but the question isn't: on launch it's still
 * open, its task waits on you, and its `ask` call ends as an error saying so. Answering it (either way) resumes the
 * task's session, with a resumed divider, and hands the agent the answer as a message (`answeredAfterRestart`) that
 * carries on the turn that asked; the agent never has to ask again.
 *
 * **Permission review** (`docs/decisions.md`, "Per-call permission review"; `../permissions`). In Allow all, the session
 * bypasses every check and no call ever asks. In the ask mode, Claude Code asks the runner about each call its rules and
 * the user's settings leave at "ask" (`canUseTool`): reads, searches, the todo and subagent tools and Glade's own tools
 * go ahead at once (`permissionVerdict`), and anything else opens a permission request and waits on it, however long it
 * takes. Meanwhile the task waits on you (its activity is waiting, and `awaitingPermission` is true), though its turn
 * is still running; parallel calls each get a request, and a message sent meanwhile is queued, since the call is still
 * running. Allow once runs the call and Deny doesn't, telling the agent, with your note if you gave one; either way the
 * turn carries on, working again once nothing else waits on you. Stop withdraws the turn's open requests first, so their
 * calls don't hold it up, and a turn that ends some other way withdraws them too; the SDK cancelling a call withdraws
 * its request. A background subagent's requests belong to it, not the turn: only its session closing withdraws them.
 * Changing the mode (`applyPermissionMode`) tells the live session at once, so it applies from the next call, mid-turn
 * too; a request already open stays open.
 *
 * Allow for this task runs the call and grants the task its rule (`taskPermissionRule`): the answer hands the rule to
 * the live session, so the calls it covers stop asking at once, and every session the task starts or resumes from then
 * on, across relaunches, starts with the task's rules (`allowedRules`). Claude Code matches them itself, compound
 * commands included. Another request already open for a call the rule covers stays open, to be answered as it is: its
 * call was asked about before the rule existed. In Allow all nothing asks anyway, and back in the ask mode the rules
 * apply again.
 *
 * If the app quits with requests open, their calls and turn are gone, but the requests aren't (`sdk-notes.md` §9): on
 * launch they're still open, their task waits on you (a turn the app quit in waits on you rather than resuming; a task
 * stopped by an error keeps its error, and a paused one waits on you once its pause is due), and each call ends as
 * interrupted, saying so. Deciding on them (`answerPermission`) hands the decisions to the agent: once every such request
 * of the task is decided, its session is resumed, with a resumed divider, and gets them all in one message
 * (`permissionsDecidedAfterRestart`) that carries on its last turn. Allow for this task saved its rule with the answer,
 * so the resumed session starts with it. An allowed call the agent makes again with the same tool and input (keys in
 * any order) goes ahead once without asking, until that turn ends; a denied one asks, if made again. Meanwhile a message
 * sent is queued, as it is while any request waits, and follows the decisions; Stop withdraws the requests, and the
 * decisions already made on the others never reach the agent. How far each request has got is saved with it
 * (`RestartDelivery`), so a relaunch in between loses nothing. A decision while the agent is busy with something else
 * (a compaction, say) is refused as busy.
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
 * **Images** pasted into a message are saved with it (`../db/repositories/images`), queued or sent, and go to the
 * session with its text, each time it's handed over: when it's sent or delivered from the queue, retried, or sent to a
 * new session on launch. A reply in words to the agent's questions can't carry images: its `ask` call takes text.
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
  PauseReason,
  PermissionDecisionKind,
  PermissionMode,
  PermissionRequestState,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  QuestionReplyKind,
  QuestionSetState,
  type ApiRetry,
  type Message,
  type PermissionDecision,
  type PermissionRequest,
  type QuestionAnswers,
  type QuestionReply,
  type QuestionSet,
  type QueuedMessage,
  type Task,
  type TaskError,
} from '../../shared/domain'
import type { ImageData } from '../../shared/images'
import { permissionRuleString, taskPermissionRule } from '../../shared/permissions'
import { checkAnswers } from '../../shared/questions'
import { apiRowArgument, apiRowResult } from '../../shared/taskError'
import { CommandFailure } from '../bridge/errors'
import {
  emitMessageAppended,
  emitQueueChanged,
  emitTodosChanged,
  emitToolEventAppended,
  emitToolEventUpdated,
  type Emit,
} from '../bridge/events'
import { ImageOwnerKind, imagesOf } from '../db/repositories/images'
import { appendMessage, lastTurn, listMessages, turnStartedAt } from '../db/repositories/messages'
import {
  getPermissionRequest,
  listAllOpenPermissionRequests,
  listRestartRequests,
  listTasksWithRestartRequests,
  restartDeliveryOf,
  RestartDelivery,
  setRestartDelivery,
} from '../db/repositories/permission-requests'
import { getOpenQuestionSet, getQuestionSet, listOpenQuestionSets } from '../db/repositories/question-sets'
import { listTaskPermissionRules } from '../db/repositories/task-permission-rules'
import { listQueuedMessages, takeQueuedMessages } from '../db/repositories/queued-messages'
import { getSettings } from '../db/repositories/settings'
import { getTask, listPausedTasks, listWorkingTasks } from '../db/repositories/tasks'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendToolCall,
  failRunningCompactions,
  interruptPausedToolCalls,
  interruptRunningToolCall,
  interruptRunningToolCalls,
  listTasksWithRunningToolCalls,
  listToolEvents,
  updateCompaction,
  updateToolCall,
} from '../db/repositories/tool-events'
import { getWorkspace } from '../db/repositories/workspaces'
import { SILENT_LOGGER, LogScope, type Logger } from '../logging/logger'
import type { NotifyReply } from '../notifications/notifications'
import { permissionVerdict, PermissionVerdict } from '../permissions/classify'
import { createPermissionBroker, type PermissionBroker } from '../permissions/permissions'
import { createQuestionBroker, toolResultFor, type QuestionBroker } from '../questions/questions'
import { addQueuedMessage } from '../tasks/queue'
import { changesTodos, todoListFor } from '../todos/todos'
import { noteAgentReply } from '../tasks/attention'
import { reopenTask, updateTaskFromRunner, updateTaskFromUser, type TaskServiceContext } from '../tasks/service'
import {
  ToolPermissionBehavior,
  type AgentBackend,
  type AgentMcpServers,
  type AgentSession,
  type AgentSessionSettings,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
} from './backend'
import { CONTROL_SERVER } from '../control/names'
import { classifyAgentError } from './error-classification'
import { gladeOwnServers } from './glade-tools'
import {
  AgentEventKind,
  createSdkMessageParser,
  type AgentEvent,
  type ApiErrorEvent,
  type ApiRetryEvent,
  type CompactedEvent,
  RateLimitStatus,
  type TextEvent,
  type ToolCallStartedEvent,
  type ToolResultEvent,
  type TaskFinishedEvent,
  TaskOutcome,
  type TurnFinishedEvent,
} from './events'
import { checkedOffline, createPauseTimers, pauseFor, pauseReason, type UsageLimit } from './pauses'
import { describeSdkMessage } from './sdk-message-log'
import { systemPromptAppend } from './system-prompt'
import { getHandoff } from '../db/repositories/backfills'
import { summarizeTurn } from './turn-summary'

export interface AgentRunnerOptions {
  readonly db: Database
  readonly emit: Emit
  readonly backend: AgentBackend
  /**
   * The questions the agent asks (`ask`): the same broker the sessions' Glade tools wait on, so the runner can answer
   * them. A broker of its own by default.
   */
  readonly questions?: QuestionBroker
  /** The permission requests the ask mode's tool calls wait on. A broker of its own by default. */
  readonly permissions?: PermissionBroker
  /** The in-process MCP servers to give a task's session, such as the Glade tools (`./glade-tools`). None by default. */
  readonly mcpServers?: (task: Task) => AgentMcpServers
  /**
   * Where the runner logs its sessions and turns, in the runner's scope, and every SDK message, in the agent's
   * (`docs/logs.md`). Nothing by default.
   */
  readonly log?: Logger
  /**
   * Notifies a final reply that arrived in a task you aren't viewing, once per reply (`../notifications`). Nothing by
   * default.
   */
  readonly notifyReply?: NotifyReply
  /**
   * Whether the network is up, checked before a turn paused offline resumes (`./pauses`): Electron's `net.isOnline()`
   * in the app. Always up by default.
   */
  readonly isOnline?: () => boolean
}

/** A message you sent: its text, and the images pasted into it, in order. */
interface UserMessage {
  readonly text: string
  readonly images: readonly ImageData[]
}

export interface AgentRunner {
  /**
   * Saves the user's message and starts a turn with it. A done task is reopened first (see the module comment). Throws
   * a `CommandFailure`: `not_found` for no such task, `busy` while a turn is running or the task is paused.
   */
  send(taskId: string, text: string, images?: readonly ImageData[]): Message
  /**
   * Answers the task's open question set with the card's answers (see the module comment), once they're checked against
   * its questions. Answers with the set, answered. Throws a `CommandFailure`: `not_found` for no such set,
   * `invalid_transition` for one that isn't open, `invalid_request` for answers that don't fit, and `busy` for a set
   * the app quit on while its task's agent is working on something else.
   */
  answer(id: string, answers: QuestionAnswers): QuestionSet
  /**
   * Answers an open permission request (see the module comment): the call waiting on it runs, or is denied with your
   * note. Answers with the request, closed. Throws a `CommandFailure`: `not_found` for no such request, and
   * `invalid_transition` for one that isn't open any more.
   */
  answerPermission(id: string, decision: PermissionDecision): PermissionRequest
  /**
   * Tells the task's live session, if it has one, the task's permission mode now: it applies from the agent's next tool
   * call, mid-turn too. A request already open stays open. Throws a `CommandFailure` `not_found` for no such task.
   */
  applyPermissionMode(taskId: string): void
  /**
   * Adds the user's message to the task's queue, for the agent to get after its current step (see the module comment).
   * When no turn is running, the queue is delivered at once, starting one, unless the task is paused: then it waits for
   * the task to resume. Throws a `CommandFailure` `not_found` for no such task.
   */
  queue(taskId: string, text: string, images?: readonly ImageData[]): QueuedMessage
  /**
   * Stops the task's running turn, and resolves with the task once the turn has ended. Does nothing for a task whose
   * agent isn't working. Throws a `CommandFailure` `not_found` for no such task.
   */
  stop(taskId: string): Promise<Task>
  /**
   * Stops one of the task's running subagents, by the `Agent` tool call that started it, leaving the turn running: the
   * call gets its result, as it would have when the subagent finished. Throws a `CommandFailure`: `not_found` for no
   * such task, and `invalid_transition` for a subagent that isn't running in the task's live session (it finished, or
   * the session doesn't know it as a task it can stop).
   */
  stopSubagent(taskId: string, toolUseId: string): Promise<void>
  /**
   * Retries the turn an error stopped or a pause holds (see the module comment), on `model` if given, which becomes the
   * task's model. Answers with the task, working again. Throws a `CommandFailure`: `not_found` for no such task, `busy`
   * while a turn is running, and `invalid_transition` for a task whose agent isn't stopped by an error or paused.
   */
  retry(taskId: string, model?: string): Task
  /**
   * Compacts the task's context now: sends its session `/compact` (see the module comment), and answers with the task,
   * now working. Throws a `CommandFailure`: `not_found` for no such task, `busy` while a turn is running, and
   * `invalid_transition` for a done or paused task, or one whose agent has no session yet.
   */
  compact(taskId: string): Task
  /**
   * Carries on the turns the app quit or crashed in, and arms the timers of the paused ones (see the module comment).
   * Call it once, on launch. Answers with the ids of the tasks whose agents picked their work back up, in the order
   * they were created.
   */
  resumeInterrupted(): string[]
  /**
   * Lets go of a task that's being deleted: withdraws the question it waits on, if any, clears its pause timer, and
   * closes its live session, if it has one, so a running turn stops and whatever the session still emits is ignored.
   * Writes nothing else: the task's rows are about to go.
   */
  discard(taskId: string): void
  /** Closes every live session and clears the pause timers, e.g. when the app quits. */
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
  /** The id of the running Compact row, until the SDK reports how the compaction went; null otherwise. */
  compaction: string | null
  /** Resolves once the turn has ended, however it ended. */
  readonly ended: Promise<void>
  readonly end: () => void
}

interface LiveSession {
  readonly session: AgentSession
  turn: Turn | null
  /** The model, effort and permission mode the session runs with now. */
  settings: AgentSessionSettings
  /** The names of the session's in-process MCP servers that are Glade's own, whose tools never ask: `glade` only. */
  readonly gladeServers: readonly string[]
  /** The permission requests the session's calls wait on, by id: whether each is a background subagent's. */
  readonly requests: Map<string, boolean>
  /**
   * The model the session last said it runs on (`system/init`), as the SDK names it there and in a turn's result, to
   * find its context window. Null until the first init.
   */
  sdkModel: string | null
  /** What the SDK last said about the account's usage limit; null until it says (it never does for an API key). */
  limit: UsageLimit | null
  /** Closed by the runner: whatever it still emits is ignored, and a turn cut short stays working, for the next launch to resume. */
  closed: boolean
  /** The SDK's task id of each subagent running in the session, by the `Agent` tool call that started it. */
  readonly subagents: Map<string, string>
  /**
   * The background subagents running in the session (see the module comment), by the `Agent` call that started each:
   * the turn that call was made in, which their own calls and notes are logged with.
   */
  readonly background: Map<string, number>
  /** The tool calls running inside a background subagent, nested subagents' included: the subagent's `Agent` call. */
  readonly backgroundCalls: Map<string, string>
}

/** What the tool log says when the user stopped a turn, and what its unfinished tool calls say. */
export const STOPPED_NOTE = 'You stopped the agent.'

/** What a background subagent stopped with Stop subagent says, and what its unfinished tool calls say. */
export const STOPPED_SUBAGENT_NOTE = 'You stopped the subagent.'

/** What a tool call still running when its background subagent finished says. */
export const SUBAGENT_ENDED_NOTE = 'The subagent ended before this tool call finished.'

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

/** What the `ask` call the app quit on says: its question stays open, and its answer goes to the agent as a message. */
export const ASK_RESTARTED_NOTE = 'Glade quit while this question was open. Its answer goes to the agent in a message.'

/**
 * What Glade sends a session it resumes to hand it the answer to a question the app quit on, before the answer itself
 * (`answeredAfterRestart`).
 */
export const ANSWERED_AFTER_RESTART_PROMPT =
  'Glade restarted while you were waiting on answers to your questions, so your ask call ended without them. The ' +
  'user has answered them now. Carry on from there.'

/** The message that hands the agent the answer to a question the app quit on. */
export function answeredAfterRestart(reply: QuestionReply): string {
  return `${ANSWERED_AFTER_RESTART_PROMPT}\n\nTheir answers, as ask would have returned them:\n${toolResultFor(reply)}`
}

/** What the agent is told when you deny a tool call, with your note if you gave one. */
export function permissionDeniedMessage(note: string | undefined): string {
  const said = note?.trim() ?? ''
  const denied = 'The user denied permission for this tool call, so it did not run.'
  return said === '' ? denied : `${denied} They said: ${said}`
}

/** What the agent is told when a tool call's permission request closed without an answer. */
export const PERMISSION_WITHDRAWN_NOTE =
  'The permission request for this tool call was withdrawn before the user answered, so it did not run.'

/**
 * What the tool call of a permission request the app quit on says: the request stays open, and the decision on it goes
 * to the agent in a message.
 */
export const PERMISSION_RESTARTED_NOTE =
  'Glade quit while this tool call waited on permission, so it did not run. The decision on it goes to the agent in ' +
  'a message.'

/**
 * What Glade sends a session it resumes to hand it the decisions on the permission requests the app quit on, before
 * the decisions themselves (`permissionsDecidedAfterRestart`).
 */
export const PERMISSIONS_DECIDED_AFTER_RESTART_PROMPT =
  "Glade restarted while tool calls of yours were waiting on the user's permission, so those calls ended without " +
  'running. The user has decided on them now:'

/** What the message that hands the agent the decisions ends with. */
export const PERMISSIONS_DECIDED_AFTER_RESTART_END =
  'Make an allowed call again, with exactly the same input, and it will run without asking again. Do not make a ' +
  'denied call again. Carry on from there.'

/** One decided request, in the message that hands the agent the decisions: the call, and what the user decided. */
function decidedAfterRestart(request: PermissionRequest): string {
  const whose =
    request.agentId === null
      ? `Your ${request.toolName} call`
      : `Your subagent's ${request.toolName} call (subagent ${request.agentId}, which ended when Glade quit)`
  const call = `- ${whose} ${request.toolUseId}, with input ${JSON.stringify(request.input)}`
  if (request.state === PermissionRequestState.Allowed) {
    const rule = request.grantedRule
    return rule === null
      ? `${call}: allowed once.`
      : `${call}: allowed, and ${permissionRuleString(rule)} is now allowed for the rest of the task.`
  }
  const note = request.denyNote ?? ''
  return note === '' ? `${call}: denied.` : `${call}: denied. The user said: ${note}`
}

/**
 * The message that hands the agent the decisions on the permission requests the app quit on (see the module comment),
 * in the order the calls were made. Each is allowed or denied.
 */
export function permissionsDecidedAfterRestart(requests: readonly PermissionRequest[]): string {
  const lines = requests.map(decidedAfterRestart).join('\n')
  return `${PERMISSIONS_DECIDED_AFTER_RESTART_PROMPT}\n\n${lines}\n\n${PERMISSIONS_DECIDED_AFTER_RESTART_END}`
}

/** A JSON value written with its objects' keys sorted, so two inputs compare equal however their keys are ordered. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The answer to a call that goes ahead without asking. */
const ALLOWED_WITHOUT_ASKING: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: false }

/** The answer to a call whose request closed without an answer, or never opened. */
const WITHDRAWN: ToolPermissionAnswer = {
  behavior: ToolPermissionBehavior.Deny,
  message: PERMISSION_WITHDRAWN_NOTE,
  byUser: false,
}

/**
 * The answer your decision on a permission request gives its call: Allow for this task with the rule it granted, which
 * the session then adds.
 */
function answerFor(decision: PermissionDecision, request: PermissionRequest): ToolPermissionAnswer {
  switch (decision.kind) {
    case PermissionDecisionKind.AllowOnce:
      return { behavior: ToolPermissionBehavior.Allow, byUser: true }
    case PermissionDecisionKind.AllowForTask: {
      // The broker only accepts Allow for this task on a request it grants a rule for.
      const rule = taskPermissionRule(request)
      return { behavior: ToolPermissionBehavior.Allow, byUser: true, ...(rule === null ? {} : { rule }) }
    }
    case PermissionDecisionKind.Deny:
      return { behavior: ToolPermissionBehavior.Deny, message: permissionDeniedMessage(decision.note), byUser: true }
  }
}

/** What a tool call cut short by a pause says. */
export const PAUSED_TOOL_NOTE = 'The task paused before this tool call finished.'

/** Whether a task's turn is paused. */
function isPaused(task: Task): boolean {
  return task.state === TaskState.Active && task.activity === TaskActivity.Paused
}

/** Whether a turn ended because it was interrupted: the SDK's `aborted_streaming` or `aborted_tools`. */
function isAborted(terminalReason: string | null): boolean {
  return terminalReason?.startsWith('aborted') === true
}

/**
 * Whether an event that arrives between turns means the agent has started a turn of its own: it's a message from the
 * agent itself, not one of its subagents (text, a tool call, or just the context it answered from), or the API error
 * that took the place of one. Anything else between turns is left over from the turn before, or may be a subagent's
 * (a retry or a compaction doesn't say whose it is), and opening a turn for it would leave one no result ever ends.
 */
function startsTurn(event: AgentEvent): boolean {
  switch (event.kind) {
    case AgentEventKind.Text:
    case AgentEventKind.ToolCallStarted:
      return event.parentToolUseId === null
    case AgentEventKind.ContextUsed:
    case AgentEventKind.ApiError:
      return true
    case AgentEventKind.SessionStarted:
    case AgentEventKind.ToolResult:
    case AgentEventKind.Compacting:
    case AgentEventKind.Compacted:
    case AgentEventKind.CompactionFailed:
    case AgentEventKind.TurnFinished:
    case AgentEventKind.SessionFailed:
    case AgentEventKind.ApiRetry:
    case AgentEventKind.RateLimit:
    case AgentEventKind.SubagentStarted:
    case AgentEventKind.SubagentBackgrounded:
    case AgentEventKind.TaskFinished:
      return false
  }
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
  const log = options.log ?? SILENT_LOGGER
  /** The runner's log for a task. */
  const taskLog = (taskId: string): Logger => log.with({ taskId })
  /** The agent's log for a task: its session and SDK messages. */
  const agentLog = (taskId: string): Logger => log.scoped(LogScope.Agent).with({ taskId })
  const notifyReply = options.notifyReply ?? (() => undefined)
  const isOnline = options.isOnline ?? (() => true)
  const context = { db, emit }
  const questions = options.questions ?? createQuestionBroker(context, notifyReply)
  const permissions = options.permissions ?? createPermissionBroker(context, notifyReply)
  const sessions = new Map<string, LiveSession>()
  // Resumes a paused turn when its pause is due.
  const timers = createPauseTimers((taskId) => {
    onPauseDue(taskId)
  })

  const setActivity = (taskId: string, activity: TaskActivity): void => {
    if (getTask(db, taskId)?.activity !== activity) updateTaskFromRunner(context, taskId, { activity })
  }

  /**
   * The agent is working on a new turn: whatever error stopped it or pause held it before is behind it, and so is any
   * retry the app quit in the middle of. The calls a pause cut off now read as interrupted.
   */
  const startWorking = (taskId: string, through: TaskServiceContext = context): void => {
    timers.disarm(taskId)
    for (const call of interruptPausedToolCalls(db, taskId)) emitToolEventUpdated(through.emit, call)
    const task = getTask(db, taskId)
    if (
      task?.activity !== TaskActivity.Working ||
      task.error !== null ||
      task.retrying !== null ||
      task.pause !== null
    ) {
      updateTaskFromRunner(through, taskId, {
        activity: TaskActivity.Working,
        error: null,
        retrying: null,
        pause: null,
      })
    }
  }

  /** A turn the app quit in is over without the agent: it waits on you, and any retry it was in is over too. */
  const backToWaiting = (taskId: string): void => {
    updateTaskFromRunner(context, taskId, { activity: TaskActivity.Waiting, retrying: null })
  }

  /**
   * The error the turn ends on, with the retries that came before it. `limit` is what the session last said about the
   * usage limit, which tells a spent limit from a passing rate limit.
   */
  const withRetries = (
    turn: Turn | null,
    error: Omit<TaskError, 'kind' | 'retries' | 'retryingMs'>,
    limit: UsageLimit | null = null,
  ): TaskError => {
    const retrying = turn?.retrying ?? null
    const facts = { status: error.status, code: error.code, message: error.details, limitRejected: limit?.rejected }
    return {
      ...error,
      kind: classifyAgentError(facts),
      retries: retrying?.attempt ?? 0,
      retryingMs: retrying === null ? 0 : Math.max(0, Date.now() - retrying.since),
    }
  }

  /** Stops the task on an error: the chat shows its card, and the task list its "Error: …" line. */
  const stopOnError = (taskId: string, error: TaskError): void => {
    updateTaskFromRunner(context, taskId, { activity: TaskActivity.Error, error, retrying: null, pause: null })
  }

  /**
   * Pauses the task's turn (see the module comment) on an error that pauses it, and arms the timer that resumes it.
   * Answers whether it paused: false for an error that stops the task instead.
   */
  const pauseOnError = (taskId: string, error: TaskError, limit: UsageLimit | null): boolean => {
    const reason = pauseReason(error)
    if (reason === null) return false
    const pause = pauseFor(reason, error.details, limit, Date.now())
    updateTaskFromRunner(context, taskId, { activity: TaskActivity.Paused, error: null, retrying: null, pause })
    timers.arm(taskId, pause.resumesAt)
    return true
  }

  /**
   * A paused turn's time has come: resume it, unless it's offline and the network is still down, when it checks again
   * later. A task that's no longer paused (resumed by hand, marked done) is left alone.
   */
  const onPauseDue = (taskId: string): void => {
    const task = getTask(db, taskId)
    if (task === undefined || !isPaused(task) || task.pause === null) return
    // A request the app quit on waits on you: the pause is over, and your decision carries the turn on.
    if (waitsOnRestartRequests(taskId)) {
      taskLog(taskId).info('pause due, waiting on permission requests left by a restart')
      updateTaskFromRunner(context, taskId, { activity: TaskActivity.Waiting, pause: null })
      return
    }
    if (task.pause.reason === PauseReason.Offline && !isOnline()) {
      taskLog(taskId).info('pause due, still offline')
      const pause = checkedOffline(task.pause, Date.now())
      updateTaskFromRunner(context, taskId, { pause })
      timers.arm(taskId, pause.resumesAt)
      return
    }
    taskLog(taskId).info('pause due, resuming', { reason: task.pause.reason })
    try {
      runner.retry(taskId)
    } catch (error) {
      taskLog(taskId).error('failed to resume paused task', { error })
      const details = `Glade couldn't resume the agent: ${describeError(error)}`
      stopOnError(taskId, withRetries(null, { source: TaskErrorSource.Session, status: null, code: null, details }))
    }
  }

  /** Claude Code will retry a failed API request: the working line says so until the agent moves on. */
  const onApiRetry = (taskId: string, turn: Turn, event: ApiRetryEvent): void => {
    const { attempt, maxRetries, delayMs, status, code } = event
    taskLog(taskId).warn('api retry', { turn: turn.number, attempt, maxRetries, delayMs, status, code })
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

  /** Marks the calls that never got a result as failed, or as paused when the turn pauses. */
  const failRunning = (taskId: string, turn: Turn, output: string, state = ToolCallState.Error): void => {
    for (const toolUseId of turn.running.keys()) {
      emitToolEventUpdated(emit, updateToolCall(db, { taskId, toolUseId, state, output }))
    }
    turn.running.clear()
  }

  const onText = (taskId: string, turn: Turn, event: TextEvent): void => {
    const { text, parentToolUseId } = event
    if (parentToolUseId === null) {
      turn.pending.push(text)
      return
    }
    // A subagent's text is the subagent's business, not the chat's: it's what the Subagents tab says it's doing.
    if (text.trim() === '') return
    emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: text.trim(), parentToolUseId }))
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

  /** Hands a user message to the session, with its images, stamped with its id (`uuid`) or a new one's. */
  const hand = (live: LiveSession, message: Message, uuid: string = message.id): void => {
    live.session.send(message.body, uuid, imagesOf(db, { kind: ImageOwnerKind.Message, id: message.id }))
  }

  /**
   * Hands the task's queue to the session mid-turn, which folds it into the running turn (see the module comment). Each
   * message goes to the chat log as a user message of the turn.
   */
  const deliverQueue = (taskId: string, live: LiveSession, turn: Turn): void => {
    const delivered = takeQueuedMessages(db, taskId, turn.number)
    if (delivered.length === 0) return
    taskLog(taskId).info('queue delivered mid-turn', { turn: turn.number, messages: delivered.length })
    emitQueueChanged(emit, taskId, [])
    for (const message of delivered) {
      emitMessageAppended(emit, message)
      turn.awaiting.add(message.id)
      hand(live, message)
    }
  }

  /** Whether the turn's top-level tool calls all have their results: the agent has finished its current step. */
  const stepFinished = (turn: Turn): boolean => ![...turn.running.values()].includes(null)

  const onToolResult = (taskId: string, live: LiveSession, turn: Turn, event: ToolResultEvent): void => {
    const parent = turn.running.get(event.toolUseId)
    if (!turn.running.delete(event.toolUseId)) {
      taskLog(taskId).warn("ignored a result for a tool call that isn't running", { toolUseId: event.toolUseId })
      return
    }
    // A background subagent's call returns once it's launched, but the subagent runs on: its row runs until it ends.
    if (event.launched && parent === null) runInBackground(live, event.toolUseId, turn.number)
    if (live.background.has(event.toolUseId)) {
      if (parent === null && !turn.stopping && stepFinished(turn)) deliverQueue(taskId, live, turn)
      return
    }
    live.subagents.delete(event.toolUseId)
    const state = event.isError ? ToolCallState.Error : ToolCallState.Done
    // A call the SDK rejects because the user stopped the agent reads like the turn's other unfinished calls.
    const output = event.isError && turn.stopping ? STOPPED_NOTE : event.output
    const call = updateToolCall(db, { taskId, toolUseId: event.toolUseId, state, output })
    emitToolEventUpdated(emit, call)
    if (changesTodos(call)) emitTodosChanged(emit, taskId, todoListFor(db, taskId))
    if (parent === null && !turn.stopping && stepFinished(turn)) deliverQueue(taskId, live, turn)
  }

  /**
   * Withdraws the permission requests the session's calls wait on: the turn's, or with `background`, its background
   * subagents' too.
   */
  const withdrawRequests = (live: LiveSession, background: boolean): void => {
    for (const [id, isBackground] of [...live.requests]) {
      if (background || !isBackground) permissions.withdraw(id)
    }
  }

  /**
   * Forgets the session's turn, and lets whoever waits on it know it has ended. A question it asked, or a permission
   * request its calls made, that's still open is withdrawn: nothing is waiting on the answer any more.
   */
  const endTurn = (taskId: string, live: LiveSession, turn: Turn): void => {
    taskLog(taskId).info('turn ended', { turn: turn.number, stopped: turn.stopping })
    live.turn = null
    turn.end()
    questions.withdraw(taskId)
    withdrawRequests(live, false)
    // A call allowed after a restart that the agent didn't make again in the turn it was told in asks, if it's made.
    const delivered = listRestartRequests(db, taskId, RestartDelivery.Delivered)
    setRestartDelivery(
      db,
      delivered.map(({ id }) => id),
      RestartDelivery.Settled,
    )
  }

  const onTurnStopped = (taskId: string, turn: Turn): void => {
    taskLog(taskId).info('turn stopped', { turn: turn.number })
    recovered(taskId, turn)
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, STOPPED_NOTE)
    emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: STOPPED_NOTE }))
    setActivity(taskId, TaskActivity.Waiting)
  }

  /** Ends the running compaction as an error, if the SDK never reported it or says it failed. */
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
   * The SDK started compacting. A compaction you asked for already has its row; one the SDK started on its own, at its
   * threshold, gets a running automatic one now, so the working line says it's compacting.
   */
  const onCompacting = (taskId: string, turn: Turn): void => {
    const task = getTask(db, taskId)
    if (task === undefined || turn.compaction !== null) return
    const compaction = appendCompaction(db, {
      taskId,
      turn: turn.number,
      trigger: CompactionTrigger.Auto,
      state: ToolCallState.Running,
      preTokens: null,
      postTokens: null,
      windowTokens: task.contextWindowTokens,
    })
    emitToolEventAppended(emit, compaction)
    turn.compaction = compaction.id
  }

  /**
   * Logs a compaction the SDK reports: fills in its running row, or adds one if the SDK never said it was compacting.
   * The context usage drops to what it reports is left.
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
      endTurn(taskId, live, turn)
      onTurnStopped(taskId, turn)
      return
    }
    if (event.isError) {
      endTurn(taskId, live, turn)
      onTurnFailed(taskId, live, turn, event)
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
    endTurn(taskId, live, turn)
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
  const onTurnFailed = (taskId: string, live: LiveSession, turn: Turn, event: TurnFinishedEvent): void => {
    const { terminalReason, errors, apiErrorStatus } = event
    taskLog(taskId).warn('turn failed', { turn: turn.number, terminalReason, errors, apiErrorStatus })
    flushPreamble(taskId, turn)
    const { apiError } = turn
    const reported = event.errors.join('\n')
    const isApiError = apiError !== null || event.apiErrorStatus !== null || event.terminalReason === 'api_error'
    if (!isApiError) {
      failRunning(taskId, turn, STOPPED_BY_ERROR_NOTE)
      const details = reported === '' ? `The turn failed (${event.terminalReason ?? 'unknown'}).` : reported
      emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: details }))
      stopOnError(taskId, withRetries(turn, { source: TaskErrorSource.Turn, status: null, code: null, details }))
      return
    }
    const details = [apiError?.message ?? '', event.result, reported].find((text) => text.trim() !== '') ?? ''
    const error = withRetries(
      turn,
      {
        source: TaskErrorSource.Api,
        status: event.apiErrorStatus,
        code: apiError?.code ?? null,
        details: details === '' ? `The API request failed (${event.terminalReason ?? 'unknown'}).` : details,
      },
      live.limit,
    )
    if (pauseReason(error) !== null) {
      failRunning(taskId, turn, PAUSED_TOOL_NOTE, ToolCallState.Paused)
      pauseOnError(taskId, error, live.limit)
      return
    }
    failRunning(taskId, turn, STOPPED_BY_ERROR_NOTE)
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
    agentLog(taskId).error('session failed', { message, turn: live.turn?.number ?? null })
    if (sessions.get(taskId) === live) sessions.delete(taskId)
    // Whatever its calls waited on went with it.
    withdrawRequests(live, true)
    // Its background subagents died with it.
    for (const toolUseId of [...live.background.keys()]) {
      finishBackground(taskId, live, toolUseId, ToolCallState.Error, message, message)
    }
    const { turn } = live
    if (turn === null) return
    endTurn(taskId, live, turn)
    failCompaction(turn)
    turn.pending.push(message)
    flushPreamble(taskId, turn)
    const error = withRetries(turn, { source: TaskErrorSource.Session, status: null, code: null, details: message })
    failRunning(taskId, turn, message, pauseReason(error) === null ? ToolCallState.Error : ToolCallState.Paused)
    if (!pauseOnError(taskId, error, live.limit)) stopOnError(taskId, error)
  }

  /**
   * Follows the subagent an `Agent` call started as one running in the background, from the turn it was made in. Any of
   * its calls the turn was waiting on are its own from now on, so the turn ending doesn't cut them off.
   */
  const runInBackground = (live: LiveSession, toolUseId: string, turn: number): void => {
    live.background.set(toolUseId, turn)
    const running = live.turn?.running
    if (running === undefined) return
    let adopted = true
    while (adopted) {
      adopted = false
      for (const [call, parent] of running) {
        if (parent === null || backgroundOwner(live, parent) !== toolUseId) continue
        running.delete(call)
        live.backgroundCalls.set(call, toolUseId)
        adopted = true
      }
    }
  }

  /** The background subagent a message from inside a subagent belongs to, by its parent call; none for a foreground one. */
  const backgroundOwner = (live: LiveSession, parentToolUseId: string | null): string | undefined => {
    if (parentToolUseId === null) return undefined
    return live.background.has(parentToolUseId) ? parentToolUseId : live.backgroundCalls.get(parentToolUseId)
  }

  /**
   * Logs what a background subagent does, whether or not a turn is running (see the module comment): its text, tool
   * calls and their results, with the turn its `Agent` call was made in. Answers whether the event was one of these.
   */
  const onBackgroundEvent = (taskId: string, live: LiveSession, event: AgentEvent): boolean => {
    if (event.kind === AgentEventKind.Text || event.kind === AgentEventKind.ToolCallStarted) {
      const { parentToolUseId } = event
      const owner = backgroundOwner(live, parentToolUseId)
      if (owner === undefined || parentToolUseId === null) return false
      const turn = live.background.get(owner) ?? 1
      if (event.kind === AgentEventKind.Text) {
        const text = event.text.trim()
        if (text !== '') emitToolEventAppended(emit, appendNarration(db, { taskId, turn, text, parentToolUseId }))
        return true
      }
      const { toolUseId, name, input } = event
      emitToolEventAppended(emit, appendToolCall(db, { taskId, turn, name, input, toolUseId, parentToolUseId }))
      live.backgroundCalls.set(toolUseId, owner)
      return true
    }
    if (event.kind !== AgentEventKind.ToolResult || !live.backgroundCalls.delete(event.toolUseId)) return false
    live.subagents.delete(event.toolUseId)
    const state = event.isError ? ToolCallState.Error : ToolCallState.Done
    emitToolEventUpdated(emit, updateToolCall(db, { taskId, toolUseId: event.toolUseId, state, output: event.output }))
    return true
  }

  /**
   * A background subagent ended: its `Agent` call's row gets what it came to, done or failed (a stopped one fails, as a
   * stopped turn's calls do), and so do its calls still running.
   */
  const finishBackground = (
    taskId: string,
    live: LiveSession,
    toolUseId: string,
    state: ToolCallState,
    output: string,
    unfinished: string,
  ): void => {
    live.background.delete(toolUseId)
    live.subagents.delete(toolUseId)
    for (const [call, owner] of live.backgroundCalls) {
      if (owner !== toolUseId) continue
      live.backgroundCalls.delete(call)
      emitToolEventUpdated(
        emit,
        updateToolCall(db, { taskId, toolUseId: call, state: ToolCallState.Error, output: unfinished }),
      )
    }
    emitToolEventUpdated(emit, updateToolCall(db, { taskId, toolUseId, state, output }))
  }

  const onTaskFinished = (taskId: string, live: LiveSession, event: TaskFinishedEvent): void => {
    if (!live.background.has(event.toolUseId)) return
    switch (event.outcome) {
      case TaskOutcome.Completed:
        finishBackground(taskId, live, event.toolUseId, ToolCallState.Done, event.summary, SUBAGENT_ENDED_NOTE)
        return
      case TaskOutcome.Failed:
        finishBackground(taskId, live, event.toolUseId, ToolCallState.Error, event.summary, SUBAGENT_ENDED_NOTE)
        return
      case TaskOutcome.Stopped:
        finishBackground(
          taskId,
          live,
          event.toolUseId,
          ToolCallState.Error,
          STOPPED_SUBAGENT_NOTE,
          STOPPED_SUBAGENT_NOTE,
        )
        return
    }
  }

  /**
   * Opens a turn the agent started on its own (see the module comment), with no message of yours: the task's next turn,
   * with its turn divider, which the agent works on like any other. It's saved in one write with the working activity,
   * so a relaunch finds the turn working and carries it on. A done task stays done. Answers with the turn.
   */
  const openTurn = (taskId: string, live: LiveSession, event: AgentEvent): Turn => {
    const number = lastTurn(db, taskId) + 1
    taskLog(taskId).info('turn started', { turn: number, selfStarted: true, by: event.kind })
    const workingEvents: GladeEvent[] = []
    const divider = db.transaction(() => {
      const divider = appendDivider(db, { taskId, turn: number, dividerKind: DividerKind.Turn })
      startWorking(taskId, { db, emit: (event) => workingEvents.push(event) })
      return divider
    })()
    emitToolEventAppended(emit, divider)
    for (const event of workingEvents) emit(event)
    live.turn = newTurn(number)
    return live.turn
  }

  const onEvent = (taskId: string, live: LiveSession, event: AgentEvent): void => {
    if (live.closed) return
    if (event.kind === AgentEventKind.SessionStarted) {
      live.sdkModel = event.model
      if (getTask(db, taskId)?.sessionId !== event.sessionId) {
        agentLog(taskId).info('session id saved', { sessionId: event.sessionId, model: event.model })
        updateTaskFromRunner(context, taskId, { sessionId: event.sessionId })
      }
      return
    }
    if (event.kind === AgentEventKind.SessionFailed) {
      onSessionFailed(taskId, live, event.message)
      return
    }
    if (event.kind === AgentEventKind.RateLimit) {
      agentLog(taskId).info('rate limit', { status: event.status, resetsAt: event.resetsAt })
      live.limit = { rejected: event.status === RateLimitStatus.Rejected, resetsAt: event.resetsAt }
      return
    }
    if (event.kind === AgentEventKind.SubagentStarted) {
      taskLog(taskId).info('subagent started', { toolUseId: event.toolUseId, sdkTaskId: event.sdkTaskId })
      live.subagents.set(event.toolUseId, event.sdkTaskId)
      if (event.background) {
        runInBackground(live, event.toolUseId, live.turn?.number ?? Math.max(1, lastTurn(db, taskId)))
      }
      return
    }
    if (event.kind === AgentEventKind.SubagentBackgrounded) {
      for (const [toolUseId, sdkTaskId] of live.subagents) {
        if (sdkTaskId === event.sdkTaskId && live.turn?.running.get(toolUseId) === null) {
          runInBackground(live, toolUseId, live.turn.number)
        }
      }
      return
    }
    if (event.kind === AgentEventKind.TaskFinished) {
      onTaskFinished(taskId, live, event)
      return
    }
    // A background subagent's work is logged whether or not a turn is running, and never opens one.
    if (onBackgroundEvent(taskId, live, event)) return
    // Between turns, the agent's own work is a turn it started itself; anything else is left over, e.g. a late system
    // message after a turn's result, and there's nothing to add it to.
    const turn = live.turn ?? (startsTurn(event) ? openTurn(taskId, live, event) : null)
    if (turn === null) return
    switch (event.kind) {
      case AgentEventKind.Text:
        recovered(taskId, turn)
        onText(taskId, turn, event)
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
        taskLog(taskId).warn('api error', { turn: turn.number, code: event.code, message: event.message })
        turn.apiError = event
        return
      case AgentEventKind.ContextUsed:
        recovered(taskId, turn)
        if (getTask(db, taskId)?.contextUsedTokens !== event.tokens) {
          updateTaskFromRunner(context, taskId, { contextUsedTokens: event.tokens })
        }
        return
      case AgentEventKind.Compacting:
        taskLog(taskId).info('compacting', { turn: turn.number })
        onCompacting(taskId, turn)
        return
      case AgentEventKind.Compacted:
        taskLog(taskId).info('compacted', {
          turn: turn.number,
          trigger: event.trigger,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
        })
        onCompacted(taskId, turn, event)
        return
      case AgentEventKind.CompactionFailed:
        taskLog(taskId).warn('compaction failed', { turn: turn.number })
        failCompaction(turn)
        return
      case AgentEventKind.TurnFinished: {
        const { isError, terminalReason, durationMs, totalCostUsd, usage } = event
        const fields = { turn: turn.number, isError, terminalReason, durationMs, totalCostUsd, usage }
        if (isError) taskLog(taskId).warn('turn result', fields)
        else taskLog(taskId).info('turn result', fields)
        recordContextWindow(taskId, live, event)
        onTurnFinished(taskId, live, turn, event)
        return
      }
    }
  }

  /** Whether something else holds the task's agent up on you: an open question, or another permission request. */
  const waitsOnYou = (taskId: string): boolean => {
    const task = getTask(db, taskId)
    return task !== undefined && (task.asking || task.awaitingPermission)
  }

  /**
   * Decides a tool call Claude Code asks about (see the module comment): at once, or once you answer the permission
   * request it opens.
   */
  const decideToolCall = async (
    taskId: string,
    live: LiveSession,
    call: ToolPermissionCall,
  ): Promise<ToolPermissionAnswer> => {
    const { toolName, toolUseId, agentId } = call
    const { permissionMode } = live.settings
    if (
      permissionMode === PermissionMode.AllowAll ||
      permissionVerdict(call, live.gladeServers) === PermissionVerdict.Allow
    ) {
      taskLog(taskId).debug('tool call allowed without asking', { toolName, toolUseId, permissionMode })
      return ALLOWED_WITHOUT_ASKING
    }
    if (live.closed) return WITHDRAWN
    const allowed = takeRestartAllowance(taskId, call)
    if (allowed !== undefined) {
      taskLog(taskId).info('tool call allowed after a restart', { requestId: allowed.id, toolName, toolUseId })
      const rule = allowed.grantedRule
      return { behavior: ToolPermissionBehavior.Allow, byUser: true, ...(rule === null ? {} : { rule }) }
    }
    // A background subagent's call belongs to the turn its `Agent` call was made in; any other, to the turn running.
    const owner = live.backgroundCalls.get(toolUseId)
    const turn =
      (owner === undefined ? live.turn?.number : live.background.get(owner)) ?? Math.max(1, lastTurn(db, taskId))
    const pending = permissions.request(
      {
        taskId,
        turn,
        toolUseId,
        agentId,
        toolName,
        input: call.input,
        title: call.title,
        displayName: call.displayName,
        description: call.description,
        suggestions: call.suggestions,
        defaultToNo: call.defaultToNo,
        suppressAlwaysAllowRule: call.suppressAlwaysAllowRule,
      },
      call.signal,
    )
    const requestId = pending.request.id
    taskLog(taskId).info('permission requested', { requestId, toolName, toolUseId, agentId, turn })
    live.requests.set(requestId, owner !== undefined)
    const decision = await pending.decision
    live.requests.delete(requestId)
    if (decision === null) {
      taskLog(taskId).info('permission withdrawn', { requestId, toolUseId })
      return WITHDRAWN
    }
    taskLog(taskId).info('permission answered', { requestId, toolUseId, decision: decision.kind })
    // The turn carries on, unless it's over or stopping, or something else still waits on you.
    const running = live.turn !== null && !live.turn.stopping && !live.closed
    if (running && !waitsOnYou(taskId)) setActivity(taskId, TaskActivity.Working)
    return answerFor(decision, pending.request)
  }

  /** Reads the session's messages for its whole life, handling each as it arrives. */
  const pump = async (taskId: string, live: LiveSession): Promise<void> => {
    const sdkLog = agentLog(taskId)
    const parse = createSdkMessageParser(sdkLog)
    const handle = (event: AgentEvent): void => {
      try {
        onEvent(taskId, live, event)
      } catch (error) {
        taskLog(taskId).error('failed to handle an agent event', { kind: event.kind, error })
      }
    }
    try {
      for await (const raw of live.session.messages) {
        const { level, fields } = describeSdkMessage(raw)
        sdkLog[level]('sdk message', fields)
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
    const allowedRules = listTaskPermissionRules(db, task.id).map(({ rule }) => rule)
    agentLog(task.id).info(task.sessionId === null ? 'session starting' : 'session resuming', {
      model: task.model,
      effort: task.effort,
      permissionMode: task.permissionMode,
      allowedRules: allowedRules.length,
      cwd: workspace.rootPath,
      resumeSessionId: task.sessionId,
    })
    const servers = mcpServers(task)
    // The session's calls are decided against the live session, which exists once the backend has started it.
    let decide: (call: ToolPermissionCall) => Promise<ToolPermissionAnswer> = () => Promise.resolve(WITHDRAWN)
    const session = backend.start({
      cwd: workspace.rootPath,
      model: task.model,
      effort: task.effort,
      permissionMode: task.permissionMode,
      resumeSessionId: task.sessionId,
      systemPromptAppend: systemPromptAppend(
        task,
        getSettings(db),
        CONTROL_SERVER in servers,
        getHandoff(db, task.id) ?? null,
      ),
      mcpServers: servers,
      allowedRules,
      log: agentLog(task.id),
      onToolPermission: (call) => decide(call),
    })
    const live: LiveSession = {
      session,
      turn: null,
      settings: { model: task.model, effort: task.effort, permissionMode: task.permissionMode },
      gladeServers: gladeOwnServers(servers),
      requests: new Map(),
      sdkModel: null,
      limit: null,
      closed: false,
      subagents: new Map(),
      background: new Map(),
      backgroundCalls: new Map(),
    }
    decide = (call) => decideToolCall(task.id, live, call)
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
    for (const call of interruptRunningToolCalls(db, taskId, RESTARTED_TOOL_NOTE)) emitToolEventUpdated(emit, call)
    const compactions = failRunningCompactions(db, taskId)
    for (const compaction of compactions) emitToolEventUpdated(emit, compaction)
    taskLog(taskId).info('resuming interrupted turn', {
      turn,
      sessionId: task.sessionId,
      compacting: compactions.length > 0,
    })
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
      hand(live, message)
    }
    return true
  }

  /**
   * The pickers change the task, not the session: its current model and effort apply from the next turn on (its
   * permission mode already applies, from `applyPermissionMode`).
   */
  const applySettings = (task: Task, live: LiveSession): void => {
    const { model, effort, permissionMode } = task
    const { settings } = live
    if (settings.model !== model || settings.effort !== effort || settings.permissionMode !== permissionMode) {
      agentLog(task.id).info('session settings changed', { model, effort, permissionMode })
      live.settings = { model, effort, permissionMode }
      live.session.configure(live.settings)
    }
  }

  /**
   * Starts a turn with the task's queued messages, in order, then `sent` if there is one: each is saved to the chat log
   * as a user message of the new turn, with its images, and handed to the session. A done task is reopened first (see
   * the module comment). Answers with the messages, in order.
   */
  const startTurn = (task: Task, live: LiveSession, sent: UserMessage | null): Message[] => {
    const taskId = task.id
    applySettings(task, live)

    const turn = lastTurn(db, taskId) + 1
    const reopening = task.state === TaskState.Done
    // The task's own events wait for the transaction to commit, so the windows never hear of a change that didn't.
    const reopenEvents: GladeEvent[] = []
    const workingEvents: GladeEvent[] = []
    const { queued, messages, dividers } = db.transaction(() => {
      // Reopening clears `doneAt`, so the marked done divider keeps it: it's the time the chat and header show. It
      // closes the task's last turn; a task done before its first (a past task backfilled done) has none to close, so
      // it goes in the new turn, before its message.
      const markedDone = reopening
        ? [
            appendDivider(
              db,
              { taskId, turn: Math.max(turn - 1, 1), dividerKind: DividerKind.MarkedDone },
              task.doneAt ?? task.updatedAt,
            ),
          ]
        : []
      if (reopening) reopenTask({ db, emit: (event) => reopenEvents.push(event) }, taskId)
      const queued = takeQueuedMessages(db, taskId, turn)
      const messages = [
        ...queued,
        ...(sent === null
          ? []
          : [appendMessage(db, { taskId, role: MessageRole.User, body: sent.text, turn, images: sent.images })]),
      ]
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
    taskLog(taskId).info('turn started', { turn, messages: messages.length, queued: queued.length, reopening })

    live.turn = newTurn(turn)
    for (const message of messages) {
      live.turn.awaiting.add(message.id)
      hand(live, message)
    }
    return messages
  }

  /** Whether the task waits on a permission request the app quit on (see the module comment). */
  const waitsOnRestartRequests = (taskId: string): boolean =>
    listRestartRequests(db, taskId, RestartDelivery.Pending).some(({ state }) => state === PermissionRequestState.Open)

  /**
   * The allowed request, told to the agent after a restart, whose call this is again (the same tool and input), if
   * there is one: it lets the call through, once.
   */
  const takeRestartAllowance = (taskId: string, call: ToolPermissionCall): PermissionRequest | undefined => {
    const input = canonicalJson(call.input)
    const found = listRestartRequests(db, taskId, RestartDelivery.Delivered).find(
      (request) => request.toolName === call.toolName && canonicalJson(request.input) === input,
    )
    if (found !== undefined) setRestartDelivery(db, [found.id], RestartDelivery.Settled)
    return found
  }

  /**
   * The permission requests the app quit on are still open, with nothing waiting on them (see the module comment):
   * their calls are gone, and so is the turn that made them, if it was still running. Their tasks wait on you until you
   * decide on them.
   */
  const orphanPermissions = (): void => {
    const open = listAllOpenPermissionRequests(db)
    setRestartDelivery(
      db,
      open.map(({ id }) => id),
      RestartDelivery.Pending,
    )
    for (const request of open) {
      const { id, taskId, toolUseId, turn } = request
      taskLog(taskId).info('permission request left open by a restart', { requestId: id, toolUseId, turn })
      const call = interruptRunningToolCall(db, taskId, toolUseId, PERMISSION_RESTARTED_NOTE)
      if (call !== undefined) emitToolEventUpdated(emit, call)
    }
    // A turn the app quit in waits on you now; one that had already ended, failed or paused stays as it was.
    for (const taskId of new Set(open.map((request) => request.taskId))) {
      if (getTask(db, taskId)?.activity === TaskActivity.Working) backToWaiting(taskId)
    }
  }

  /**
   * Hands the agent the decisions on the permission requests the app quit on, once you've made them all (see the module
   * comment): its session is resumed, and they go to it in one message that carries on its last turn. Does nothing while
   * one is still open.
   */
  const deliverAfterRestart = (taskId: string): void => {
    const pending = listRestartRequests(db, taskId, RestartDelivery.Pending)
    const task = getTask(db, taskId)
    const busy = (sessions.get(taskId)?.turn ?? null) !== null
    if (task === undefined || busy || pending.some(({ state }) => state === PermissionRequestState.Open)) return
    const turn = Math.max(1, lastTurn(db, taskId))
    taskLog(taskId).info('permission decisions sent after a restart', { requests: pending.length, turn })
    const live = sessions.get(taskId) ?? start(task)
    const allowed = (request: PermissionRequest): boolean => request.state === PermissionRequestState.Allowed
    setRestartDelivery(
      db,
      pending.filter(allowed).map(({ id }) => id),
      RestartDelivery.Delivered,
    )
    setRestartDelivery(
      db,
      pending.filter((request) => !allowed(request)).map(({ id }) => id),
      RestartDelivery.Settled,
    )
    applySettings(task, live)
    startWorking(taskId)
    emitToolEventAppended(emit, appendDivider(db, { taskId, turn, dividerKind: DividerKind.Resumed }))
    const uuid = randomUUID()
    live.turn = newTurn(turn)
    live.turn.awaiting.add(uuid)
    live.session.send(permissionsDecidedAfterRestart(pending), uuid)
  }

  /**
   * Stop on a task waiting on permission requests the app quit on: they're withdrawn, and the decisions already made on
   * the others never reach the agent.
   */
  const dropAfterRestart = (taskId: string): void => {
    const pending = listRestartRequests(db, taskId, RestartDelivery.Pending)
    if (pending.length === 0) return
    taskLog(taskId).info('permission requests left by a restart withdrawn', { requests: pending.length })
    setRestartDelivery(
      db,
      pending.map(({ id }) => id),
      RestartDelivery.Settled,
    )
    for (const { id, state } of pending) if (state === PermissionRequestState.Open) permissions.withdraw(id)
  }

  /**
   * A question the app quit on is still open, with nothing waiting on it (see the module comment): its call is gone,
   * and so is its turn. Its task waits on you until you answer it.
   */
  const orphanQuestion = (set: QuestionSet): void => {
    taskLog(set.taskId).info('question left open by a restart', { questionSetId: set.id, turn: set.turn })
    for (const call of interruptRunningToolCalls(db, set.taskId, ASK_RESTARTED_NOTE)) emitToolEventUpdated(emit, call)
    setActivity(set.taskId, TaskActivity.Waiting)
  }

  /**
   * Hands the agent the answer to a question the app quit on: its session is resumed, and the answer goes to it as a
   * message that carries on the turn that asked.
   */
  const continueAfterRestart = (task: Task, set: QuestionSet, reply: QuestionReply): void => {
    taskLog(task.id).info('answer sent after a restart', { questionSetId: set.id, turn: set.turn })
    const live = sessions.get(task.id) ?? start(task)
    applySettings(task, live)
    startWorking(task.id)
    emitToolEventAppended(
      emit,
      appendDivider(db, { taskId: task.id, turn: set.turn, dividerKind: DividerKind.Resumed }),
    )
    const uuid = randomUUID()
    live.turn = newTurn(set.turn)
    live.turn.awaiting.add(uuid)
    live.session.send(answeredAfterRestart(reply), uuid)
  }

  /**
   * Checks an open question set's answer can go to the agent now: a call waits on it, or, for a question the app quit
   * on, the agent isn't busy with something else (a compaction, say), so its session can take it. Answers with its
   * task.
   */
  const answerable = (set: QuestionSet): Task => {
    const task = getTask(db, set.taskId)
    if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${set.taskId}`)
    if (!questions.isWaiting(set.id) && (sessions.get(task.id)?.turn ?? null) !== null) {
      throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; answer once it has finished')
    }
    return task
  }

  /**
   * Answers an open question set with your reply: the call waiting on it gets it, or, for a question the app quit on,
   * the resumed session does. Check it's `answerable` first.
   */
  const replyTo = (task: Task, set: QuestionSet, reply: QuestionReply): QuestionSet => {
    const waiting = questions.isWaiting(set.id)
    const answered = questions.answer(set.id, reply)
    if (!waiting) continueAfterRestart(task, answered, reply)
    return answered
  }

  /**
   * Answers the open question set in your own words: the message goes to the chat log as your reply, in the turn that
   * asked, and the agent gets it as the answer.
   */
  const answerInWords = (set: QuestionSet, text: string): Message => {
    const task = answerable(set)
    const message = appendMessage(db, { taskId: task.id, role: MessageRole.User, body: text, turn: set.turn })
    emitMessageAppended(emit, message)
    replyTo(task, set, { kind: QuestionReplyKind.FreeText, text })
    return message
  }

  const runner: AgentRunner = {
    send(taskId, text, images = []) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      // The agent waits on answers to its questions: the message answers them, rather than starting a turn.
      const open = getOpenQuestionSet(db, taskId)
      if (open !== undefined) {
        if (images.length > 0) {
          throw new CommandFailure(
            BridgeErrorCode.InvalidRequest,
            'An answer to the agent’s questions can’t have images',
          )
        }
        return answerInWords(open, text)
      }
      if (waitsOnRestartRequests(taskId)) {
        throw new CommandFailure(
          BridgeErrorCode.Busy,
          'The agent is waiting on your permission; queue the message instead',
        )
      }
      if ((sessions.get(taskId)?.turn ?? null) !== null) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; queue the message instead')
      }
      if (isPaused(task)) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The task is paused; queue the message instead')
      }
      // The message sent is the last of the turn's: any queued ones go before it.
      const message = startTurn(task, sessions.get(taskId) ?? start(task), { text, images }).at(-1)
      if (message === undefined) throw new Error(`The turn for task ${taskId} started without its message`)
      return message
    },

    answer(id, answers) {
      const set = getQuestionSet(db, id)
      if (set === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No question set ${id}`)
      if (set.state !== QuestionSetState.Open) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'The questions are not open any more')
      }
      const checked = checkAnswers(set.questions, answers)
      if (!checked.ok) throw new CommandFailure(BridgeErrorCode.InvalidRequest, checked.problems.join('; '))
      return replyTo(answerable(set), set, { kind: QuestionReplyKind.Answers, answers: checked.answers })
    },

    answerPermission(id, decision) {
      const request = getPermissionRequest(db, id)
      if (request?.state !== PermissionRequestState.Open || restartDeliveryOf(db, id) !== RestartDelivery.Pending) {
        return permissions.answer(id, decision)
      }
      // The app quit on it: the decision goes to the agent's session, which mustn't be busy with something else.
      if ((sessions.get(request.taskId)?.turn ?? null) !== null) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; answer once it has finished')
      }
      const answered = permissions.answer(id, decision)
      deliverAfterRestart(request.taskId)
      return answered
    },

    applyPermissionMode(taskId) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const live = sessions.get(taskId)
      if (live === undefined || live.settings.permissionMode === task.permissionMode) return
      agentLog(taskId).info('permission mode changed', {
        from: live.settings.permissionMode,
        to: task.permissionMode,
        turn: live.turn?.number ?? null,
      })
      live.settings = { ...live.settings, permissionMode: task.permissionMode }
      live.session.configure(live.settings)
    },

    queue(taskId, text, images = []) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const queued = addQueuedMessage(context, { taskId, body: text, images })
      // A paused task delivers its queue once it resumes, and one waiting on requests the app quit on once you decide.
      if (isPaused(task) || waitsOnRestartRequests(taskId)) return queued
      const live = sessions.get(taskId)
      // The turn ended just before the message arrived: nothing will deliver the queue, so it starts a turn now.
      if ((live?.turn ?? null) === null) startTurn(task, live ?? start(task), null)
      return queued
    },

    async stop(taskId) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      dropAfterRestart(taskId)
      const live = sessions.get(taskId)
      const turn = live?.turn ?? null
      if (live === undefined || turn === null) return getTask(db, taskId) ?? task
      taskLog(taskId).info('stop requested', { turn: turn.number })
      turn.stopping = true
      // An `ask` or a permission request waiting on you would hold the turn up: they're withdrawn first, so their calls
      // return.
      questions.withdraw(taskId)
      withdrawRequests(live, false)
      await live.session.interrupt()
      await turn.ended
      return getTask(db, taskId) ?? task
    },

    async stopSubagent(taskId, toolUseId) {
      if (getTask(db, taskId) === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const live = sessions.get(taskId)
      const sdkTaskId = live?.subagents.get(toolUseId)
      if (live === undefined || sdkTaskId === undefined) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, "The subagent isn't running")
      }
      taskLog(taskId).info('subagent stop requested', { toolUseId, sdkTaskId })
      await live.session.stopTask(sdkTaskId)
    },

    retry(taskId, model) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      if ((sessions.get(taskId)?.turn ?? null) !== null) {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working')
      }
      const last = listMessages(db, taskId).findLast((message) => message.role === MessageRole.User)
      const stopped = task.activity === TaskActivity.Error || task.activity === TaskActivity.Paused
      if (task.state !== TaskState.Active || !stopped || last === undefined) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, "The agent isn't stopped by an error or paused")
      }
      const current = model === undefined ? task : updateTaskFromUser(context, taskId, { model })
      const live = sessions.get(taskId) ?? start(current)
      applySettings(current, live)
      startWorking(taskId)
      // The same turn again: its last message goes to the session once more, and the chat log stays as it is.
      taskLog(taskId).info('turn retried', { turn: last.turn, model: current.model, from: task.activity })
      const uuid = randomUUID()
      live.turn = newTurn(last.turn)
      live.turn.awaiting.add(uuid)
      hand(live, last, uuid)
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
      if (isPaused(task)) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'A paused task is compacted once it resumes')
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
      taskLog(taskId).info('compaction requested', { turn })
      setActivity(taskId, TaskActivity.Working)
      live.turn = newTurn(turn)
      live.turn.compaction = compaction.id
      const uuid = randomUUID()
      live.turn.awaiting.add(uuid)
      live.session.send(COMPACT_COMMAND, uuid)
      return getTask(db, taskId) ?? task
    },

    resumeInterrupted() {
      // A permission request or question the app quit on waits on you, not the agent: its turn carries on once you
      // answer it.
      orphanPermissions()
      for (const set of listOpenQuestionSets(db)) orphanQuestion(set)
      // A background subagent the app quit in died with its session: its calls end as interrupted, in any task.
      for (const taskId of listTasksWithRunningToolCalls(db)) {
        if (getTask(db, taskId)?.activity === TaskActivity.Working) continue
        for (const call of interruptRunningToolCalls(db, taskId, RESTARTED_TOOL_NOTE)) emitToolEventUpdated(emit, call)
      }
      const resumed: string[] = []
      for (const task of listWorkingTasks(db)) {
        try {
          if (resume(task)) resumed.push(task.id)
        } catch (error) {
          taskLog(task.id).error('failed to resume task', { error })
          const text = `Glade couldn't resume the agent: ${describeError(error)}`
          emitToolEventAppended(
            emit,
            appendNarration(db, { taskId: task.id, turn: Math.max(1, lastTurn(db, task.id)), text }),
          )
          const failure = { source: TaskErrorSource.Session, status: null, code: null, details: text }
          stopOnError(task.id, withRetries(null, failure))
        }
      }
      // Decisions made on requests the app quit on that never reached the agent (it quit again first) go now.
      for (const taskId of listTasksWithRestartRequests(db, RestartDelivery.Pending)) {
        try {
          deliverAfterRestart(taskId)
        } catch (error) {
          taskLog(taskId).error('failed to send permission decisions after a restart', { error })
        }
      }
      for (const task of listPausedTasks(db)) timers.arm(task.id, task.pause?.resumesAt ?? Date.now())
      log.info('resumed interrupted tasks', { resumed })
      return resumed
    },

    discard(taskId) {
      questions.withdraw(taskId)
      permissions.withdrawAll(taskId)
      timers.disarm(taskId)
      const live = sessions.get(taskId)
      if (live === undefined) return
      agentLog(taskId).info('session closed', { reason: 'task deleted', turn: live.turn?.number ?? null })
      sessions.delete(taskId)
      live.closed = true
      live.session.close()
      live.turn?.end()
    },

    close() {
      // A question or permission request still open stays open for the next launch, though closing its session cancels
      // the call.
      questions.close()
      permissions.close()
      timers.close()
      for (const [taskId, live] of sessions) {
        agentLog(taskId).info('session closed', { reason: 'app closing', turn: live.turn?.number ?? null })
        live.closed = true
        live.session.close()
        live.turn?.end()
      }
      sessions.clear()
    },
  }
  return runner
}
