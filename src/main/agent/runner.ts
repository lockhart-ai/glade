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
 *   the tool log as narration carrying its `Agent` call's id, for the Agents tab, and never to the chat.
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
 * **Watchers** (`../watchers`, `docs/sdk-notes.md` §13). What the agent leaves running or scheduled with those tools is
 * followed as a watcher from what the SDK reports: the tasks it starts and ends, the calls' results, and two hooks the
 * session is given, the prompt hook (each prompt about to start a turn) and the `Stop` hook (the jobs it still has as
 * each turn ends). The runner remembers the prompts it sends (`give`), so one of its own is never taken for a wake;
 * anything else goes to the watchers, which count it and can turn away a job you stopped. Stop on a monitor or command
 * stops its SDK task (`stopWatcher`). A failed session ends its watchers with it, and a launch ends those of every
 * session, but for the cron jobs, which wait for their session to resume. What a subagent leaves running is its own,
 * not the task's: the runner tells the watchers which subagent's call started each (`callParents`, for a call the tool
 * log doesn't have), and when a subagent is stopped, stops the monitors and commands it leaves behind.
 *
 * **Commits** (`../changes/tracker`, `docs/sdk-notes.md` §14). Each `Bash` call is put to the change tracker before it
 * runs (the session's `PreToolUse` hook, which the call waits for) and once its result is in, a subagent's and a
 * background subagent's too, so the commits a task makes are linked to it for the Todos tab's commit tiles. The tracker reads git in
 * the background; it never holds up a turn, and a failed session forgets its calls that were running.
 *
 * **Background subagents** (`docs/sdk-notes.md`, "Background subagents"). An `Agent` call with `run_in_background`
 * returns as soon as its subagent is launched, and the turn carries on and ends without waiting for it, so the task goes
 * back to waiting on you and takes messages while the subagent works. The subagent isn't done then: its `Agent` call's
 * row keeps running, for the Agents tab, until the SDK's task notification says it ended, when it's done, or failed
 * (a stopped one fails, as a stopped turn's calls do). Its calls and notes are logged as they arrive, whether a turn is
 * running or not, with the turn its `Agent` call was made in; they never open a turn, and a turn ending doesn't cut
 * them off. Stop subagent stops it by the SDK's task id, as a foreground one. The agent then usually starts a turn of
 * its own to report on it (above). A background subagent dies with its session: if the session fails, it fails with it,
 * and if the app quits, its calls end as interrupted on the next launch.
 *
 * **Subagents woken again** (`docs/sdk-notes.md`, "Subagents woken again", #395). A subagent that has finished, failed
 * or been interrupted (a relaunch included) runs again when the agent messages it with `SendMessage`, or when the SDK
 * starts it again once work it left running ends: the SDK sends a new `task_started` under the subagent's task id,
 * which its `Agent` call keeps in SQLite from its first start. Its row goes back to running, keeping its log, and it's
 * followed as a background subagent from then on, until that run's task notification, which the SDK sends under the
 * waking call's id, ends it as done or failed. A subagent started before Glade kept the ids is known by the run's first
 * message instead, whose parent is its `Agent` call.
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
 * - when a turn ends with messages still queued, they start the next turn, together. A turn you stopped ends like any
 *   other here (#441): Stop drops what the agent is doing, not what you said next.
 * - a failed turn leaves the queue alone: it stays queued until you send again, and then goes first, before what you
 *   sent. So does a turn that ends on a done task.
 * - a task found waiting on you with messages queued and nothing left to deliver them (a turn stopped before #441,
 *   say) is stuck: its queue starts a turn on launch (`resumeInterrupted`), and when Stop is pressed with no turn
 *   running.
 * A **broadcast** (#489, `../tasks/broadcast`) is a message like any other, marked as one in the queue and the chat
 * log, but for a task waiting on answers to its questions: it never answers them, so there it's queued, and delivered
 * once they're answered.
 * If the SDK answers a message handed to it mid-turn with a turn of its own (its result doesn't list the message), the
 * runner's turn carries on until a result does, saving each reply on the way.
 *
 * **Stop** interrupts the running turn (`docs/sdk-notes.md` §7): the SDK ends it within tens of milliseconds with an
 * aborted result, and the session stays alive for the next message. A stopped turn isn't a failure: its activity goes
 * back to waiting on you. What it already saved stays. Its held-back text, including the partial text the SDK flushes
 * when it aborts, goes to the tool log as narration rather than the chat, since it isn't a finished reply; its
 * unfinished tool calls end as errors; and a narration notes that you stopped it. Messages still queued then start the
 * next turn at once, as after any turn, so the task goes straight back to working.
 *
 * **Errors** (`docs/design/html/16-error.html`). Glade doesn't retry a failed API request itself: Claude Code already
 * retries the transient ones with backoff, and says so before each retry (`docs/sdk-notes.md`, "Errors and retries").
 * While it does, the task's `retrying` says which retry it is, for the working line, until the agent moves on. When a
 * turn ends on an error anyway, or the session fails mid-turn, the task stops on it: its activity is error and its
 * `error` says what happened (`./error-classification` sorts it into a kind), for the chat's error card. Its held-back
 * text goes to the tool log as narration and its unfinished tool calls end as errors; an API error adds a failed "API"
 * row to the tool log, and any other error a note saying why. What the turn already saved stays. A session Claude Code
 * couldn't start ends its turn with a result naming the reason (`startup_failure_reason`), which the card words.
 *
 * **Pauses** (`docs/design/html/17-usage-limit.html`, `./pauses`). A turn that ends on the account's usage limit, or
 * because the API can't be reached, doesn't stop the task on an error: the task pauses, its activity paused and its
 * `pause` saying why and when it resumes, for the app-wide banner, the task list and the chat's paused line. Its
 * held-back text goes to the tool log as narration and its unfinished tool calls end as errors, as for an error, but
 * the tool log gets no failed API row. Messages sent meanwhile wait in the queue. The pause resumes on its own: at the
 * limit's reset time (from the SDK's `rate_limit_event`), or once the network is back (`isOnline`), with a timer that a
 * relaunch arms again. Resuming is a retry (below), and the queue follows once the turn ends. Retrying a paused task
 * yourself, e.g. on another model, resumes it at once. So does `resumePaused`, for a usage limit's pause ended early
 * (#519, `../account/usage-resume`): the banner's Resume now, and a usage reading (`refreshUsage` asks for one) that
 * says the account can run again. A turn still over the limit pauses again, with the reset time it's given.
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
 * bypasses every check and no call ever asks (but for the sandbox's, below). In the ask mode, Claude Code asks the
 * runner about each call its rules and the user's settings leave at "ask" (`canUseTool`): reads, searches, the todo and subagent tools and Glade's own tools
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
 * decisions already made on the others never reach the agent, though a queue then starts a turn of its own. How far each request has got is saved with it
 * (`RestartDelivery`), so a relaunch in between loses nothing. A decision while the agent is busy with something else
 * (a compaction, say) is refused as busy.
 *
 * **The agent sandbox** (#445, `./sandbox`, `docs/sdk-notes.md` §15). With Settings' `sandboxEnabled` on as a session
 * starts, it runs in the sandbox for its whole life: it starts with only the fixed parts (`sandboxStartSettings`), and
 * straight after, before its first message, gets the overlay for its mode and grants (`sandboxOverlay`, applied with
 * `applyFlagSettings`), as it does again whenever its mode changes, or its grants do (`applySandboxGrants`: the
 * grants are saved per task, per workspace and Glade-wide, `../sandbox/grants`). Its messages wait on that first overlay
 * (`gatedSession`), and a session that won't take an overlay is closed rather than left running without it, its turn
 * ending on the sandbox's error (`onSandboxNotApplied`). Allow all then runs as `acceptEdits`, never
 * bypassing: the calls Claude Code asks about go ahead, but for the ones crossing the sandbox's bounds, which ask in
 * either mode, as does every request to run a command outside the sandbox (`toolCallVerdict`). If a command fails
 * because the sandbox couldn't start (`sandboxFailureReason`), the session refuses every request to run outside it from
 * then on, without asking, and the turn ends on the error, with its card; Retry restarts the session, so its sandbox
 * gets another go. With the sandbox off, sessions start and decide their calls as they always have.
 *
 * **Glade decides at the sandbox's bounds before Claude Code's rules do** (#514). Claude Code only asks Glade about a
 * call its own rules leave at "ask", and the user's own settings can allow anything. So a sandboxed session's
 * `PreToolUse` hook, which runs in every mode and before any rule, puts each file-tool, `WebFetch`, `Bash` and
 * `Monitor` call to the runner first (`toolStarting`): one inside the bounds is left to Claude Code, and one that
 * crosses them is decided there and then, exactly as it would be if Claude Code had asked (`decideToolCall`), the hook
 * held while its card waits. What the hook lets through is remembered for as long as it takes Claude Code to ask about
 * the same call after all (its own ask rules still apply), so nothing is asked twice. Claude Code is told of no grant
 * for its file tools, so every such call outside the workspace root reaches Glade one way or the other.
 *
 * **What runs outside the sandbox** (#515). An MCP server Glade doesn't build (the user's, a repository's, a
 * connector) runs outside the sandbox with whatever access it has, and `SendMessage` and `RemoteTrigger` reach agents
 * that do. So the same hook hears of every MCP tool's call, and of those two tools', and each asks until what it uses
 * is granted (`outsideUse`): the server, whichever of its tools is called, or the other agents. One card per server,
 * not per call: calls that arrive while its card is open wait on that card's answer. Glade's own in-process servers
 * never ask, nor does a `SendMessage` to one of the task's own subagents. Once granted, a call is left to Claude Code
 * and decided as with the sandbox off. The servers a session names are kept for its workspace
 * (`reported_mcp_servers`), for Settings to offer.
 *
 * **The sandbox's cards** (#450, `../permissions/sandbox-ask`). A call that crosses the bounds opens a request that
 * says what it asks for (`PermissionRequest.sandbox`): a folder, for a file tool outside the grants; a domain, for
 * `WebFetch` or a command's connection, whose request is put on the command running at the time, since the SDK doesn't
 * say which made it; or to run a command outside the sandbox. A folder or domain is allowed for the task or for its
 * workspace: the answer saves the grant (`../permissions/permissions`), and the call that waited applies it
 * (`applySandboxGrants`, waiting on its own session only) before it goes on, so what it lets through, and the agent's
 * retry, find it in force. Nothing goes back to the SDK with the answer but that the call may run: no rule, and
 * nothing for a settings file. Running outside the sandbox is allowed once, and asks again every time. A call whose
 * folder or host can't be granted, and a write the sandbox's own checks hold back, get the plain card, allowed once or
 * denied. The agent asks for a folder itself with Glade's `request_access` tool (`requestAccess`), when the sandbox
 * blocked a command: it opens the same folder card, and returns once you've answered and the grant is live. The
 * tool's handler isn't told which call it answers or whose, so the session's `PreToolUse` hook says
 * (`onAccessRequested`). A request the app quit on is answered as any other: the grant is saved with the answer, and
 * the session Glade resumes to tell the agent starts with it. A command's connection to a host no card can name (not
 * a plain host name) is refused: allowing a connection "once" would let the session keep the host for its whole life.
 *
 * **A denial lasts the turn.** A folder or domain you denied isn't asked for again in the same turn: the same request
 * again (the agent's `request_access`, a file tool's or `WebFetch`'s crossing, a command's connection, a subagent's
 * as much as the agent's own) is answered denied at once, with the note you gave, and no card. A read you denied
 * denies a write to the same folder too; a write you denied still lets a read ask. Your next message starts a new
 * turn, and it may ask again. (A background subagent's requests belong to the turn its `Agent` call was made in.)
 * Requests open at the same time each keep their card.
 *
 * **What a rule decided** (`PermissionMark`). Where Glade can tell that a rule, not you, decided a call, it marks the
 * call, for its row in the Tool calls list to say: a file tool or `WebFetch` a sandbox grant covers ("Allowed by
 * workspace grant"), a call in the ask mode that a rule from an earlier Allow for this task covers ("Allowed by task
 * rule"), a sandboxed command that failed saying "Operation not permitted" ("Blocked by the sandbox", naming what of
 * once the same agent's next call is a `request_access` that says), a credential path refused, and a
 * `request_access` call answered without a card. A call in the workspace root with no rule involved has no mark, and a
 * call you're asked about shows your answer instead. A call that crosses the sandbox's bounds is never marked allowed:
 * it's asked about or refused whatever rule covers it. Each mark is saved, and only that call's goes to the windows.
 * Marking costs a call nothing it didn't already pay: the path is resolved once, by the classifier, and the task's
 * rules and grants are kept on the session between changes to them.
 *
 * **Filing under todos** (P16-04, #495; `../todo-hub/filing`, `docs/sdk-notes.md` §16). Every session has the todo
 * hub: its prompt says so (a session resumed from before it is sent the lines once, `./session-context`), Claude
 * Code's task tools stay on whatever the user's settings say, and three hooks file what the agent produces. Each `Agent` call, and each `Bash` call of its own in the foreground (it
 * may commit), is read as it streams and again before it runs (`childStarting`): `[todo N]` at the start of its
 * description names its todo, the subagent is recorded as working on it or the commits are filed under it, and the
 * marker comes off the call's row in the tool log and off the input the tool runs with, so it shows nowhere. A
 * watcher's call (`Monitor`, background `Bash`, `ScheduleWakeup`, `CronCreate`) is left exactly as it is. Once a message's calls have run (`batchFinished`), the agent is told of what they
 * made that's under no todo, with their results, and files it with one `file_children` call. And a turn about to end
 * with a filing owed is held (`turnEnding`), twice at most; the reply it had written goes to the tool log as
 * narration, since the agent writes it again (if it doesn't, that reply is the turn's after all). A turn you stopped,
 * and a compaction, are never held. A subagent is never asked to file anything: what it commits follows its todo,
 * and so does a subagent it starts, unless that call names another.
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
 * - a task in error, paused or done has no turn running, so it's left as it is, queue and all: an error keeps its card
 *   and Retry. So is one waiting on you, unless it's active with messages queued and neither a question nor a
 *   permission request open: nothing else would ever send them, so they start its next turn (#441).
 *
 * **Images** pasted into a message are saved with it (`../db/repositories/images`), queued or sent, and go to the
 * session with its text, each time it's handed over: when it's sent or delivered from the queue, retried, or sent to a
 * new session on launch. So do the **files attached** to it (#396, `../attachments/attachments`): a line with each
 * one's path at the end of its text, and each image among them as an image too, read from its copy as it's handed
 * over. A reply in words to the agent's questions can't carry images or files: its `ask` call takes text.
 *
 * Every write is broadcast to the windows as it happens. Only the in-flight turn's bookkeeping (its held-back text and
 * running calls) is kept in memory.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, type GladeEvent } from '../../shared/bridge'
import {
  API_TOOL_NAME,
  AgentErrorKind,
  LIVE_WATCHER_STATES,
  CompactionTrigger,
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionDecisionKind,
  PermissionMarkKind,
  PermissionMode,
  PermissionRequestState,
  RefusalScope,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  WatcherKind,
  QuestionReplyKind,
  QuestionSetState,
  type ApiRetry,
  type Message,
  type PastedBlock,
  type PermissionDecision,
  type PermissionMarkOutcome,
  type PermissionRule,
  type ToolInput,
  type PermissionRequest,
  type QuestionAnswers,
  type QuestionReply,
  type QuestionSet,
  type QueuedMessage,
  type Task,
  type TaskError,
  type ToolCallEvent,
} from '../../shared/domain'
import type { ImageData } from '../../shared/images'
import { permissionRuleString, ruleCovers, taskPermissionRule } from '../../shared/permissions'
import type { ReportedMcpServer } from '../../shared/mcpServers'
import {
  FolderAccess,
  folderVerb,
  grantCovers,
  isGrantAsk,
  sandboxAskPhrase,
  SandboxAskKind,
  SandboxGrantKind,
  SandboxGrantScope,
  type CardGrantScope,
  type FolderGrant,
  type GrantedTask,
  type SandboxApplyResult,
  type SandboxAsk,
  type SandboxFolderAsk,
  type SandboxGrantAsk,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import { agentText } from '../../shared/pastedContent'
import { withAttachedFiles, type AttachedFile } from '../../shared/attachedFiles'
import { attachedImagesOf } from '../attachments/attachments'
import { checkAnswers, tidyAnythingElse } from '../../shared/questions'
import { isSubagentTool } from '../../shared/subagents'
import { managedBackend } from './managed-backend'
import { AGENTS_SERVER, DISPATCH_AGENT_TOOL } from '../../shared/managed-agents'
import { sandboxFailureReason } from '../../shared/sandboxFailure'
import { apiRowArgument, apiRowResult } from '../../shared/taskError'
import { CommandFailure } from '../bridge/errors'
import {
  emitMessageAppended,
  emitPermissionMarked,
  emitQueueChanged,
  emitTaskUpdated,
  emitTodosChanged,
  emitToolEventAppended,
  emitToolEventRemoved,
  emitToolEventUpdated,
  type Emit,
} from '../bridge/events'
import { ImageOwnerKind, imagesOf } from '../db/repositories/images'
import { appendMessage, lastTurn, listMessages, turnStartedAt } from '../db/repositories/messages'
import {
  getPermissionRequest,
  listAllOpenPermissionRequests,
  listPermissionRequests,
  listRestartRequests,
  listTasksWithRestartRequests,
  restartDeliveryOf,
  RestartDelivery,
  setRestartDelivery,
  type NewPermissionRequest,
} from '../db/repositories/permission-requests'
import { getPermissionMark, setPermissionMark } from '../db/repositories/permission-marks'
import { getOpenQuestionSet, getQuestionSet, listOpenQuestionSets } from '../db/repositories/question-sets'
import { listTaskPermissionRules } from '../db/repositories/task-permission-rules'
import { listQueuedMessages, listTasksWithQueuedMessages, takeQueuedMessages } from '../db/repositories/queued-messages'
import { getSettings } from '../db/repositories/settings'
import { getTask, listPausedTasks, listWorkingTasks } from '../db/repositories/tasks'
import { recordReportedWindow } from '../db/repositories/context-windows'
import { offeredModels } from '../db/repositories/sdk-models'
import { matchReportedWindow } from '../../shared/contextWindow'
import { findModel, modelName } from '../../shared/models'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendRefusalFallback,
  appendToolCall,
  deleteToolEvent,
  failRunningCompactions,
  findSubagentCall,
  getToolCall,
  interruptPausedToolCalls,
  interruptRunningToolCall,
  interruptRunningToolCalls,
  previousToolCall,
  listTasksWithRunningToolCalls,
  listToolCallsNamed,
  listToolEvents,
  reopenSubagentCall,
  setSubagentProgress,
  setSubagentTaskId,
  updateCompaction,
  updateToolCall,
} from '../db/repositories/tool-events'
import { getWatcher, listWatchers } from '../db/repositories/watchers'
import { getWorkspace } from '../db/repositories/workspaces'
import { noteReportedServers } from '../db/repositories/reported-mcp-servers'
import { createWatcherTracker, StopAction } from '../watchers/watchers'
import { createChangeTracker, type ChangeTracker } from '../changes/tracker'
import { createGit, type Git } from '../git/git'
import { SILENT_LOGGER, LogScope, type Logger } from '../logging/logger'
import type { NotifyReply } from '../notifications/notifications'
import { PermissionVerdict } from '../permissions/classify'
import {
  callStanding,
  fetchedHost,
  fileToolPath,
  isGrantedUse,
  isOutsideTool,
  isSandboxOverride,
  isUnboundedRule,
  isWriteTool,
  outsideUse,
  sandboxBounds,
  sandboxCrossing,
  SandboxCrossing,
  toolCallVerdict,
  type OutsideUse,
  type SandboxBounds,
} from '../permissions/sandbox-classify'
import { absolutePath, keyInside } from '../permissions/canonical-path'
import {
  cardGrantTarget,
  createPermissionBroker,
  FOLDER_MOVED_NOTE,
  type PermissionBroker,
} from '../permissions/permissions'
import {
  AccessOutcomeKind,
  accessPlan,
  AccessPlanKind,
  deniedCovers,
  outsideAsk,
  sandboxAskFor,
  type AccessOutcome,
  type AccessRequest,
  type RunningCommand,
} from '../permissions/sandbox-ask'
import { grantingGrant, heldGrants, type GrantingGrant } from '../sandbox/grants'
import { createQuestionBroker, toolResultFor, type QuestionBroker } from '../questions/questions'
import { addQueuedMessage } from '../tasks/queue'
import { changesTodos, refreshTodos } from '../todos/todos'
import { noteAgentReply } from '../tasks/attention'
import { reopenTask, updateTaskFromRunner, updateTaskFromUser, type TaskServiceContext } from '../tasks/service'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AccessCallStarting,
  type AgentBackend,
  type AgentMcpServers,
  type AgentSession,
  type AgentSessionSettings,
  type BashCallFinished,
  type BashFinishedAnswer,
  type ChildCallStarting,
  type CompactSummary,
  type SessionJob,
  type ToolBatch,
  type ToolCallStarting,
  type TurnEnding,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
  type ToolStartDecision,
} from './backend'
import { namedTodo, readsTodo } from './child-calls'
import { createExcludedCommands, type ExcludedCommands } from './excluded-commands'
import { gatedSession } from './gated-session'
import { AgentSource, agentSource } from '../../shared/openrouter'
import { taskModelWindow } from '../db/repositories/context-windows'
import { completeModelSwitch, validateModel } from '../models/switches'
import { getOpenRouterChoice } from '../db/repositories/openrouter'
import { effortWithModel, listModels } from '../models/models'
import { FileAccess, SANDBOX_NETWORK_TOOL } from './sandbox-requests'
import { NO_GRANTS, sandboxOverlay, sandboxStartSettings, usableGrants, type SandboxGrants } from './sandbox'
import { CONTROL_SERVER } from '../control/names'
import { limitOfWindow, type AccountSink } from '../account/account'
import { autoCompactFrom, carriedOver, sameAutoCompact } from './compaction'
import { classifyAgentError } from './error-classification'
import { ACCESS_TOOL_NAME, gladeOwnServers, type AccessCall } from './glade-tools'
import {
  AgentEventKind,
  createSdkMessageParser,
  type AgentEvent,
  type ApiErrorEvent,
  type ApiRetryEvent,
  type CompactedEvent,
  type ModelRefusalFallbackEvent,
  RateLimitStatus,
  type SubagentStartedEvent,
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
import { getSessionContext, setSessionContext } from '../db/repositories/session-context'
import {
  contextAfter,
  contextBlock,
  missingContext,
  startedContext,
  withContext,
  type ContextCheck,
} from './session-context'
import { summarizeTurn } from './turn-summary'
import { createChildFiler } from '../todo-hub/filing'

/** A stuck SDK initialization must release the picker and keep the original session usable. */
export const MODEL_SWITCH_TIMEOUT_MS = 30_000
async function waitForModelSwitch(ready: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('The new model session did not start within 30 seconds. The task was not switched.'))
        }, MODEL_SWITCH_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

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
  /** Variables to add to a task's session's environment as it starts. None by default. */
  readonly sessionEnv?: (task: Task) => Readonly<Record<string, string>>
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
  /**
   * Works out the commits each task's `Bash` calls make, for the Todos tab's commit tiles (`../changes/tracker`). One reading the
   * `git` on the PATH by default.
   */
  readonly changes?: ChangeTracker
  /**
   * How the change tracker the runner makes reads git, when it's given none (`changes`): the `git` on the PATH by
   * default. The runner's own tracker is the one that says when a call's commits are linked, which the todo hub files
   * them by.
   */
  readonly git?: Git
  /**
   * Told what each session says of the account (`../account/account`): the account, asked for as the session starts;
   * its usage, asked for as the session starts and after each turn; and every `rate_limit_event`. Nothing is asked or
   * told by default.
   */
  readonly account?: AccountSink
  /**
   * Told when a task stops on a lost login (an `AgentErrorKind.LoggedOut` error, #409), so a login that finished before
   * no longer reads as having fixed it (`../account/login`). Nothing by default.
   */
  readonly onLoggedOut?: (taskId: string) => void
  /**
   * What's granted to a task beyond its workspace root, for its session's sandbox (#445): read as the session starts,
   * and again for each running session a change to the grants covers (`AgentRunner.applySandboxGrants`). The app reads
   * the grants' store (`../sandbox/grants`). Nothing by default.
   */
  readonly sandboxGrants?: (task: Task) => SandboxGrants
  /**
   * Glade's own data folder (Electron's `userData`: the database, with the grants, the settings and the control token):
   * no sandboxed session's commands or file tools may read or write it, even inside a granted folder (#514). None by
   * default.
   */
  readonly dataDir?: string
  /**
   * The Claude Code settings files a session in a workspace root merges with Glade's own, for the commands they keep
   * out of the sandbox (`./excluded-commands`): the app names the user's, the project's and the local ones. None by
   * default, so a test reads nothing of the machine it runs on.
   */
  readonly claudeSettings?: (root: string) => readonly string[]
}

/**
 * A message you sent: its text, the images pasted into it, the text pasted into it, kept apart, the files attached
 * to it, already copied into the workspace, and whether it's a broadcast.
 */
interface UserMessage {
  readonly text: string
  readonly images: readonly ImageData[]
  readonly pastedBlocks: readonly PastedBlock[]
  readonly files: readonly AttachedFile[]
  readonly broadcast: boolean
}

/** How `AgentRunner.applySandboxGrants` waits on the sessions it applies to. */
export interface SandboxApplyOptions {
  /** The one task whose session to wait on: the one that asked for the grant. Every covered session by default. */
  readonly awaitTaskId?: string
}

export interface AgentRunner {
  /** Prepares a safe model/source change without consuming messages or changing history on failure. */
  changeModel(taskId: string, model: string): Promise<Task>
  /**
   * Saves the user's message and starts a turn with it. A done task is reopened first (see the module comment). Throws
   * a `CommandFailure`: `not_found` for no such task, `busy` while a turn is running or the task is paused. With
   * `broadcast`, the message is saved as a broadcast (#489), and is `busy` too for a task waiting on answers to its
   * questions, rather than answering them.
   */
  send(
    taskId: string,
    text: string,
    images?: readonly ImageData[],
    pastedBlocks?: readonly PastedBlock[],
    files?: readonly AttachedFile[],
    broadcast?: boolean,
  ): Message
  /**
   * Answers the task's open question set with the card's answers (see the module comment), once they're checked against
   * its questions, and what you typed in its "Anything else?" box, trimmed (left out when blank). Answers with the set,
   * answered. Throws a `CommandFailure`: `not_found` for no such set, `invalid_transition` for one that isn't open,
   * `invalid_request` for answers that don't fit, and `busy` for a set the app quit on while its task's agent is
   * working on something else.
   */
  answer(id: string, answers: QuestionAnswers, anythingElse?: string): QuestionSet
  /**
   * Answers an open permission request (see the module comment): the call waiting on it runs, or is denied with your
   * note. Answers with the request, closed. Throws a `CommandFailure`: `not_found` for no such request, and
   * `invalid_transition` for one that isn't open any more.
   */
  answerPermission(id: string, decision: PermissionDecision): PermissionRequest
  /**
   * A task's agent, or one of its subagents, asks for the folder of a path the sandbox blocked (Glade's
   * `request_access` tool, see the module comment). With nothing to decide, resolves at once: the session isn't
   * sandboxed, the path is in the workspace root, already usable as asked, a credential path, or one no grant can
   * name. Otherwise it opens the folder's card and resolves once you've answered and, allowed, the grant is in force in
   * the session; or once the request is withdrawn (`call.signal`, Stop, the turn ending, the session closing).
   */
  requestAccess(taskId: string, request: AccessRequest, call: AccessCall): Promise<AccessOutcome>
  /**
   * Tells the task's live session, if it has one, the task's permission mode now: it applies from the agent's next tool
   * call, mid-turn too. A request already open stays open. Throws a `CommandFailure` `not_found` for no such task.
   */
  applyPermissionMode(taskId: string): void
  /**
   * Applies the sandbox grants to the running sandboxed sessions a change to `target`'s grants covers (one task, a
   * workspace's tasks, or every task): each reads its task's grants again (`AgentRunnerOptions.sandboxGrants`), decides
   * its calls against them from then on, and gets the whole overlay with `applyFlagSettings`, without restarting.
   * Resolves with which sessions have it and which wouldn't take it, once every one has answered; or, given
   * `awaitTaskId`, once that task's session has, the others applying in the background (`pending`), so one stuck
   * session can't hold up the answer to the session that asked. A session that won't take its overlay is closed, its
   * task stopping on the sandbox's error (`closed`), as at start. A task with no running session, or one that started
   * with the sandbox off, is left alone: its next session starts with the grants.
   */
  applySandboxGrants(target: SandboxGrantTarget, options?: SandboxApplyOptions): Promise<SandboxApplyResult>
  /**
   * Adds the user's message to the task's queue, for the agent to get after its current step (see the module comment).
   * When no turn is running, the queue is delivered at once, starting one, unless the task is paused, or waits on
   * requests or questions the app quit on: then it waits for the task to resume, or for you to decide or answer. With
   * `broadcast`, the message is queued as a broadcast (#489). Throws a `CommandFailure` `not_found` for no such task.
   */
  queue(
    taskId: string,
    text: string,
    images?: readonly ImageData[],
    pastedBlocks?: readonly PastedBlock[],
    files?: readonly AttachedFile[],
    broadcast?: boolean,
  ): QueuedMessage
  /**
   * Stops the task's running turn, and resolves with the task once the turn has ended: working again, on its next turn,
   * if messages were queued (see the module comment). Does nothing for a task whose
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
   * Stops one of the task's live watchers (`../watchers`), and resolves once the SDK has been asked: a monitor or
   * background command by its SDK task id, its end arriving as the SDK reports it; a wakeup or cron job at once, its
   * fires turned away from then on. Throws a `CommandFailure`: `not_found` for no such task or watcher, and
   * `invalid_transition` for one that has ended, or a monitor or command whose session isn't running.
   */
  stopWatcher(taskId: string, id: string): Promise<void>
  /**
   * Retries the turn an error stopped or a pause holds (see the module comment), on `model` if given, which becomes the
   * task's model. Answers with the task, working again. Throws a `CommandFailure`: `not_found` for no such task, `busy`
   * while a turn is running, and `invalid_transition` for a task whose agent isn't stopped by an error or paused.
   */
  retry(taskId: string, model?: string): Task
  /**
   * Resumes the task's paused turn now, as when its pause comes due (see the module comment): Resume now, and a usage
   * reading that says the account can run again (#519). A task that isn't paused is left alone.
   */
  resumePaused(taskId: string): void
  /**
   * Asks a live session how much of the account's usage limits is used, as each does after its turns: a paused task's
   * session answers with no turn running. Answers false when no session is live, when there's nothing to ask.
   */
  refreshUsage(): boolean
  /**
   * Compacts the task's context now: sends its session `/compact` (see the module comment), and answers with the task,
   * now working. Throws a `CommandFailure`: `not_found` for no such task, `busy` while a turn is running, and
   * `invalid_transition` for a done or paused task, or one whose agent has no session yet.
   */
  compact(taskId: string): Task
  /**
   * Carries on the turns the app quit or crashed in, arms the timers of the paused ones, and sends the queues a stopped
   * turn left behind (see the module comment).
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

/** Top-level text pushed since the last tool call, with the assistant message it came from, for eviction. */
interface PendingText {
  readonly text: string
  readonly sdkUuid: string | null
}

/** Where a row a refusal-fallback retry may supersede came from: the tool call it's for, when it is one. */
interface SdkRow {
  readonly id: string
  readonly toolUseId: string | null
}

/** What a turn's `model_refusal_no_fallback` said, kept until the turn's result ends it as declined. */
interface TurnRefusal {
  readonly category: string | null
  readonly explanation: string | null
  readonly content: string
}

/** The in-flight turn's bookkeeping. */
interface Turn {
  readonly number: number
  /** Top-level text since the last tool call: preamble if a tool call follows, else the final reply. */
  readonly pending: PendingText[]
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
  /** Whether the turn is a compaction you asked for (`compact`), not a turn of the agent's: its end is never held. */
  compactOnly: boolean
  /**
   * The reply the agent had written when the turn's end was last held for filings owed (#495), which went to the tool
   * log: the turn's reply after all, if the agent writes none once it has filed. Null while the turn was never held
   * with a reply written.
   */
  heldReply: string | null
  /**
   * The turn's own rows a refusal-fallback retry may still supersede, by the SDK message uuid that made each: the
   * turn's narration and tool call rows logged so far (`./events.ts`, `TextEvent.sdkUuid`).
   */
  readonly sdkRows: Map<string, SdkRow>
  /** What the turn's `model_refusal_no_fallback` said, once it has; null while none has, or none did. */
  refusal: TurnRefusal | null
  /**
   * Claude Code's message for the session's sandbox failing to start, once a command in the turn has failed with it:
   * the turn ends on that error. Null while none has.
   */
  sandboxFailure: string | null
  /** Resolves once the turn has ended, however it ended. */
  readonly ended: Promise<void>
  readonly end: () => void
}

/** Whether one task's session took the sandbox overlay it was sent. */
interface SandboxApplied {
  readonly taskId: string
  readonly applied: boolean
}

/** The agent sandbox a live session runs in (#445). */
interface LiveSandbox {
  /** The workspace root: the one folder the agent may always read and write. */
  readonly root: string
  /** What's granted to the task beyond its root, as last read: at start, and whenever its grants change. */
  grants: SandboxGrants
  /** The bounds the root and those grants make, as the session's calls are decided against them. */
  bounds: SandboxBounds
  /**
   * Every grant that covers the task, each with its scope, for saying whose grant let a call through (`heldGrants`):
   * read when first needed, and again once the grants change. Null until then.
   */
  held: readonly GrantingGrant[] | null
  /**
   * The write tools the task was granted whole (Allow for this task), which the session isn't told of: Glade decides
   * their calls itself, so the rule never reaches past the sandbox's bounds (`toolCallVerdict`).
   */
  readonly writeRules: Set<string>
  /**
   * Claude Code's message for the sandbox failing to start in the session, once a command has failed with it; null
   * while none has. From then on, every request to run outside the sandbox is refused without asking.
   */
  failure: string | null
  /** The commands the user's Claude Code settings keep out of the sandbox, as the files stand (`./excluded-commands`). */
  readonly excluded: ExcludedCommands
  /**
   * The cards open for an MCP server or for other agents, by what each asks for (`sharedCardKey`): settled once its
   * card is answered or withdrawn, and any grant applied. Another call that needs the same waits on it, rather than
   * opening a card of its own.
   */
  readonly asking: Map<string, Promise<void>>
  /**
   * The calls the session's `PreToolUse` hook let through (`toolStarting`), by `tool_use` id, up to `MAX_HANDED`: if
   * Claude Code goes on to ask about one (an ask rule of its own, or its check of the files that run code), it gets
   * the same answer, with no second card.
   */
  readonly started: Map<string, ToolStartDecision>
}

interface LiveSession {
  readonly session: AgentSession
  /** The task the session is, and its workspace: what its grants are found by. */
  readonly owner: GrantedTask
  turn: Turn | null
  /** The model, effort and permission mode the session runs with now. */
  settings: AgentSessionSettings
  /** The sandbox the session runs in; null when it started with the sandbox off. */
  readonly sandbox: LiveSandbox | null
  /**
   * The task's permission rules (Allow for this task), for marking the calls one covers in the ask mode: read when
   * first needed, and again after an answer, which may have added one. Null until then.
   */
  rules: readonly PermissionRule[] | null
  /** The names of the session's in-process MCP servers that are Glade's own, whose tools never ask: `glade` only. */
  readonly gladeServers: readonly string[]
  /**
   * The session's own in-process MCP servers, by name (`glade`, and `glade-control` while agents may control Glade):
   * Glade's, whose tools need no grant (#515), and which aren't among the servers a workspace has reported.
   */
  readonly inProcess: readonly string[]
  /**
   * The MCP servers the session has named that Glade has kept for its workspace, by key: each one's name as kept, so
   * the same list, turn after turn, is written once.
   */
  readonly reported: Map<string, string>
  /** Whether the session has the `glade-control` tools, which its system prompt says. */
  readonly control: boolean
  /** The permission requests the session's calls wait on, by id: whether each is a background subagent's. */
  readonly requests: Map<string, boolean>
  /**
   * The `request_access` calls the session's hook has told of that their handler hasn't picked up yet, oldest first, up
   * to `MAX_HANDED`: which call each is, and whose.
   */
  readonly accessCalls: AccessCallStarting[]
  /**
   * The model the session last said it runs on (`system/init`), as the SDK names it there and in a turn's result, to
   * find its context window. Null until the first init.
   */
  sdkModel: string | null
  /**
   * Whether the session's model has changed since it started (the picker, a retry on another model, or a refusal's
   * fallback): a lone `modelUsage` entry may then be the model before, so it's matched by name only.
   */
  modelChanged: boolean
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
  /**
   * The subagents another call woke again (the agent's `SendMessage`), by that call's id: the `Agent` call of each. The
   * SDK reports the new run's progress and end under the waking call (`docs/sdk-notes.md`, "Subagents woken again").
   */
  readonly woken: Map<string, string>
  /**
   * The subagents a `SendMessage` woke that Glade doesn't know by their SDK task id (started before it kept the ids): the
   * waking call, by SDK task id, oldest first, until the run's first message names its `Agent` call.
   */
  readonly unknownWakes: Map<string, string>
  /**
   * Every tool call the session has made that hasn't had its result, logged or not: the `Agent` call of the subagent
   * that made it, or null for the agent's own. Whose a background task is, when the SDK starts one for the call.
   */
  readonly callParents: Map<string, string | null>
  /**
   * The prompts Glade has sent the session that its prompt hook hasn't seen yet, oldest first, up to `MAX_HANDED`: a
   * prompt of Glade's own is never a wake, nor turned away.
   */
  readonly handed: string[]
  /**
   * What the compaction under way carried over, from its `PostCompact` hook, until the SDK reports it done
   * (`compact_boundary`), which comes just after; null otherwise.
   */
  compactSummary: string | null
}

/** What wakes a subagent again: the SDK's task id for it, and the call the SDK reports its run under. */
interface SubagentWake {
  readonly sdkTaskId: string
  readonly toolUseId: string
}

/** How many of Glade's own prompts a session remembers for its prompt hook (a message folded into a turn may never pass it). */
const MAX_HANDED = 20

/** The tool whose calls may commit: the change tracker hears of each one's result. */
const BASH_TOOL = 'Bash'

/** The tool the agent messages a subagent with, which wakes one that has finished (`docs/sdk-notes.md`). */
const SEND_MESSAGE_TOOL = 'SendMessage'

/** The SDK's kind of task for a subagent (`task_started.task_type`). */
const SUBAGENT_TASK = 'local_agent'

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

/** What the tool log says when a request was declined by a safety check with no fallback model to retry it on. */
export const DECLINED_TOOL_NOTE = 'The agent stopped: the request was declined by a safety check.'

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
 * What the agent is told when it asks to run a command outside a sandbox that couldn't start: refused without asking,
 * since Glade never runs a command unsandboxed for a session whose sandbox failed (#445).
 */
export const SANDBOX_FAILED_REFUSAL =
  "Glade refused to run this command outside the sandbox: the sandbox couldn't start in this session, and Glade never " +
  'runs commands unsandboxed instead. Commands will keep failing until the session restarts. Stop running commands ' +
  "and tell the user the sandbox couldn't start; they can retry the task to restart it."

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

/** One decided request for something a grant gives, in that message: what was asked for, and what the user decided. */
function grantDecidedAfterRestart(request: PermissionRequest, ask: SandboxGrantAsk): string {
  const whose = request.agentId === null ? 'Your' : "Your subagent's"
  // A folder by its whole path, as the agent named it; anything else as its line says it.
  const wanted = ask.kind === SandboxAskKind.Folder ? `${folderVerb(ask.access)} ${ask.path}` : sandboxAskPhrase(ask)
  const asked = `- ${whose} request to ${wanted} (${request.toolName} call ${request.toolUseId})`
  if (request.state === PermissionRequestState.Allowed) {
    const scope = request.grantedScope === SandboxGrantScope.Workspace ? 'this workspace' : 'this task'
    return `${asked}: allowed for ${scope}, and in force now. Run what needed it again.`
  }
  const note = request.denyNote ?? ''
  return note === '' ? `${asked}: denied.` : `${asked}: denied. The user said: ${note}`
}

/** One decided request, in the message that hands the agent the decisions: the call, and what the user decided. */
function decidedAfterRestart(request: PermissionRequest): string {
  const ask = grantAskOf(request)
  if (ask !== null) return grantDecidedAfterRestart(request, ask)
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
const WITHDRAWN: ToolStartDecision = {
  behavior: ToolPermissionBehavior.Deny,
  message: PERMISSION_WITHDRAWN_NOTE,
  byUser: false,
}

/** What a background subagent or watcher ends with when its session is restarted because its sandbox couldn't start. */
export const SANDBOX_RESTARTED_NOTE = "Stopped: the session was restarted because its sandbox couldn't start."

/** What the agent is told when it reads or writes a credential path in a sandboxed session: refused without asking. */
export const CREDENTIAL_REFUSAL =
  'Glade refused this: the path is one of the credential files and folders the sandbox never lets the agent read or ' +
  "write, whatever else it's been allowed. Don't try to reach it another way; if the task needs it, tell the user."

/**
 * How the error begins when a sandboxed session wouldn't take its sandbox settings (`applyFlagSettings` was refused, or
 * failed): what the SDK said follows.
 */
export const SANDBOX_NOT_APPLIED = "couldn't apply the sandbox settings: "

/**
 * The error a task stops on when its session's sandbox couldn't start: Claude Code's message, which names why, or why
 * the session wouldn't take its sandbox settings (`SANDBOX_NOT_APPLIED`).
 */
function sandboxError(failure: string): TaskError {
  return {
    kind: AgentErrorKind.Permanent,
    source: TaskErrorSource.Sandbox,
    status: null,
    code: null,
    details: failure,
    retries: 0,
    retryingMs: 0,
  }
}

/** What the runner adds to a finished `Bash` call's result: nothing. */
const NOTHING_TO_ADD: BashFinishedAnswer = { context: null }

/** The answer to a read or write of a credential path in a sandboxed session: refused, with no card. */
const CREDENTIAL_REFUSED: ToolStartDecision = {
  behavior: ToolPermissionBehavior.Deny,
  message: CREDENTIAL_REFUSAL,
  byUser: false,
}

/**
 * What the agent is told when a file tool names a path Glade can't say the real place of (#514): one through macOS's
 * `/.nofollow`, `/.vol` or `/.resolve`, which name any file on the disk by another path, or a loop of links. Refused
 * without asking: a card couldn't say what allowing it would open.
 */
export const UNRESOLVABLE_REFUSAL =
  "Glade refused this: it can't tell where the path really leads (it goes through /.nofollow, /.vol or /.resolve, or " +
  "a loop of links), so it can't check it against the sandbox. Use the file's ordinary absolute path."

/** The answer to a read or write of a path that can't be resolved: refused, with no card. */
const UNRESOLVABLE_REFUSED: ToolStartDecision = {
  behavior: ToolPermissionBehavior.Deny,
  message: UNRESOLVABLE_REFUSAL,
  byUser: false,
}

/**
 * What the agent is told when a command's connection is to a host no permission card can name: refused without asking,
 * since a connection can't be allowed just once (the session would keep the host for as long as it runs).
 */
export const CONNECTION_REFUSAL =
  "Glade refused this connection: its host isn't a plain host name (like registry.npmjs.org), so the user can't be " +
  'asked to allow it. If the task needs it, tell the user.'

/** The answer to a command's connection to a host no card can name: refused, with no card. */
const CONNECTION_REFUSED: ToolPermissionAnswer = {
  behavior: ToolPermissionBehavior.Deny,
  message: CONNECTION_REFUSAL,
  byUser: false,
}

/**
 * What the agent is told when a call asks for a folder or domain the user denied earlier in the turn: denied again,
 * with the note they gave then, without asking them.
 */
export function alreadyDeniedMessage(note: string | null): string {
  const denied =
    "The user already denied this earlier in the turn, so they weren't asked again and it did not run. Don't try it " +
    'again this turn.'
  return note === null ? denied : `${denied} They said: ${note}`
}

/** The answer to a request to run outside a sandbox that couldn't start: refused, with no card. */
const SANDBOX_FAILED: ToolStartDecision = {
  behavior: ToolPermissionBehavior.Deny,
  message: SANDBOX_FAILED_REFUSAL,
  byUser: false,
}

/** What a call the sandbox refuses without asking is answered with, by how it stands to the bounds. */
function refusalFor(crossing: SandboxCrossing): ToolStartDecision {
  switch (crossing) {
    case SandboxCrossing.Credential:
      return CREDENTIAL_REFUSED
    case SandboxCrossing.Unresolvable:
      return UNRESOLVABLE_REFUSED
    // Only a request to leave a sandbox that couldn't start is refused otherwise.
    case SandboxCrossing.Override:
    case SandboxCrossing.Boundary:
    case SandboxCrossing.Protected:
    case SandboxCrossing.None:
      return SANDBOX_FAILED
  }
}

/** A permission request once it has closed: your decision on it, or null when it was withdrawn. */
interface DecidedRequest {
  readonly request: PermissionRequest
  readonly decision: PermissionDecision | null
}

/** The tools whose calls run a command in the sandbox: a connection's request belongs to one of them. */
const COMMAND_TOOL_NAMES: readonly string[] = ['Bash', 'Monitor']

/**
 * What a command the sandbox blocked fails with, in whatever case its tool writes it (`docs/sdk-notes.md` §15). Only a
 * failed command's error counts: one that printed it and went on (a file's text, say) wasn't stopped by the sandbox.
 */
const BLOCKED_BY_SANDBOX = /operation not permitted/i

/**
 * How many turns of the microtask queue a connection's request waits for its command's `tool_use` to be logged, when
 * none is running yet: enough for a message already streamed to reach the log, and no time at all.
 */
const COMMAND_TICKS = 20

/** What a request asks a grant for: a folder, a domain, an MCP server or other agents; null for any other request. */
function grantAskOf(request: Pick<PermissionRequest, 'sandbox'>): SandboxGrantAsk | null {
  const { sandbox } = request
  return sandbox === null || !isGrantAsk(sandbox) ? null : sandbox
}

/**
 * What the calls waiting on one card share (#515): an MCP server's key, or which other agents. A card for one of these
 * answers for every call that needs the same, so only one is ever open in a session. Null for any other request: a
 * folder's or a domain's call asks for itself.
 */
function sharedCardKey(ask: SandboxAsk | null): string | null {
  switch (ask?.kind) {
    case SandboxAskKind.McpServer:
      return `${ask.kind}:${ask.server}`
    case SandboxAskKind.Agents:
      return `${ask.kind}:${ask.agents}`
    case SandboxAskKind.Folder:
    case SandboxAskKind.Domain:
    case SandboxAskKind.Outside:
    case undefined:
      return null
  }
}

/** What a call did with a granted folder (or single file), as its mark says it: the grant's own path, and the access used. */
function grantedAsk(grant: FolderGrant, access: FolderAccess): SandboxFolderAsk {
  const { path, file } = grant
  return { kind: SandboxAskKind.Folder, path, access, ...(file === true ? { file } : {}) }
}

/** Who a decision grants a request's folder or domain to; null when it grants none. */
function grantedScope(decision: PermissionDecision, request: PermissionRequest): CardGrantScope | null {
  if (grantAskOf(request) === null) return null
  switch (decision.kind) {
    case PermissionDecisionKind.AllowForTask:
      return SandboxGrantScope.Task
    case PermissionDecisionKind.AllowForWorkspace:
      return SandboxGrantScope.Workspace
    case PermissionDecisionKind.AllowOnce:
    case PermissionDecisionKind.Deny:
      return null
  }
}

/**
 * The answer your decision on a permission request gives its call: Allow for this task with the rule it granted, which
 * the session then adds. A folder or domain's grant is in the session's settings by then (`applySandboxGrants`), so
 * nothing goes with the answer: no rule, and nothing a settings file would keep.
 */
function answerFor(decision: PermissionDecision, request: PermissionRequest): ToolPermissionAnswer {
  switch (decision.kind) {
    case PermissionDecisionKind.AllowOnce:
    case PermissionDecisionKind.AllowForWorkspace:
      return { behavior: ToolPermissionBehavior.Allow, byUser: true }
    case PermissionDecisionKind.AllowForTask: {
      // The broker only accepts Allow for this task on a request it grants a rule for, or a folder or domain.
      const rule = request.sandbox === null ? taskPermissionRule(request) : null
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
    case AgentEventKind.McpServersReported:
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
    case AgentEventKind.SubagentProgress:
    case AgentEventKind.TaskFinished:
    case AgentEventKind.ModelRefusalFallback:
    case AgentEventKind.ModelRefusalNoFallback:
    case AgentEventKind.MessagesEvicted:
      // A refusal-fallback notice, the eviction it (or a superseding message) carries, and a no-fallback refusal all
      // belong to a turn already under way: with none running, there's nothing to attribute them to.
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
    compactOnly: false,
    heldReply: null,
    sdkRows: new Map(),
    refusal: null,
    sandboxFailure: null,
    ended,
    end,
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  const { db, emit } = options
  const backend = managedBackend({
    db,
    backend: options.backend,
    ...(options.account === undefined ? {} : { account: options.account }),
  })
  const mcpServers = options.mcpServers ?? (() => ({}))
  const sessionEnv = options.sessionEnv ?? (() => ({}))
  // The home folder, whose reads the agent sandbox denies but for the folders granted.
  const home = homedir()
  // What no sandboxed session may read or write, besides the credential paths: Glade's own data folder.
  const denied: readonly string[] = options.dataDir === undefined ? [] : [options.dataDir]
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
  const watchers = createWatcherTracker({ db, emit })
  // Files what the agents' own calls make under their todos: only a session with the todo hub on ever asks it to.
  const filer = createChildFiler({ db, emit })
  const changes =
    options.changes ??
    createChangeTracker({
      db,
      emit,
      git: options.git ?? createGit(),
      log,
      onCommitsLinked: (taskId, toolUseId) => {
        filer.commitsLinked(taskId, toolUseId)
      },
    })
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
    taskId: string,
    turn: Turn | null,
    error: Omit<TaskError, 'kind' | 'retries' | 'retryingMs'>,
    limit: UsageLimit | null = null,
  ): TaskError => {
    const retrying = turn?.retrying ?? null
    const facts = { status: error.status, code: error.code, message: error.details, limitRejected: limit?.rejected }
    return {
      ...error,
      kind:
        agentSource(getTask(db, taskId)?.model ?? '') === AgentSource.OpenRouter &&
        [AgentErrorKind.LoggedOut, AgentErrorKind.UsageLimit].includes(classifyAgentError(facts))
          ? AgentErrorKind.Permanent
          : classifyAgentError(facts),
      retries: retrying?.attempt ?? 0,
      retryingMs: retrying === null ? 0 : Math.max(0, Date.now() - retrying.since),
    }
  }

  /** Stops the task on an error: the chat shows its card, and the task list its "Error: …" line. */
  const stopOnError = (taskId: string, error: TaskError): void => {
    updateTaskFromRunner(context, taskId, { activity: TaskActivity.Error, error, retrying: null, pause: null })
    if (error.kind === AgentErrorKind.LoggedOut) options.onLoggedOut?.(taskId)
  }

  /**
   * Before a turn a lost login or a sandbox that couldn't start stopped is retried: closes the task's live session, so
   * the retry starts Claude Code afresh, resuming the same conversation. The new process reads the login you've just
   * made (a running Claude Code mostly picks a new login up by itself, on its next 401, `docs/sdk-notes.md` §1,
   * "Logging in", but not when it started with none at all), and starts its sandbox again (§15).
   *
   * For a new login, a session with background work going on (a background subagent, or a live watcher) is kept, so
   * retrying never kills it: that retry relies on Claude Code picking the login up. For a sandbox that couldn't start
   * (`endingBackground`), it's closed all the same, and its background work ends, saying why: nothing in that session
   * can run a command, and retrying in it would only fail the same way.
   */
  const restartSession = (taskId: string, reason: string, endingBackground: string | null = null): void => {
    const live = sessions.get(taskId)
    if (live === undefined) return
    const watching = listWatchers(db, taskId).some(({ state }) => LIVE_WATCHER_STATES.includes(state))
    const busy = live.background.size > 0 || watching
    if (busy && endingBackground === null) {
      agentLog(taskId).info('session kept for a retry: background work is running', {
        reason,
        subagents: live.background.size,
        watching,
      })
      return
    }
    agentLog(taskId).info('session closed', { reason, subagents: live.background.size, watching })
    if (busy && endingBackground !== null) {
      sessionGone(taskId, live, endingBackground)
    } else {
      sessions.delete(taskId)
      changes.sessionEnded(taskId)
    }
    live.closed = true
    live.session.close()
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
    if (switching.has(taskId)) {
      deferredPauses.add(taskId)
      return
    }
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
      stopOnError(
        taskId,
        withRetries(taskId, null, { source: TaskErrorSource.Session, status: null, code: null, details }),
      )
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

  /** Saves the held-back text as narration, if there is any, and remembers it for a later eviction, if it names a uuid. */
  const flushPreamble = (taskId: string, turn: Turn): void => {
    const parts = turn.pending.splice(0)
    const text = parts
      .map((part) => part.text)
      .join('\n\n')
      .trim()
    if (text === '') return
    const narration = appendNarration(db, { taskId, turn: turn.number, text })
    emitToolEventAppended(emit, narration)
    for (const { sdkUuid } of parts) {
      if (sdkUuid !== null) turn.sdkRows.set(sdkUuid, { id: narration.id, toolUseId: null })
    }
  }

  /** Marks the calls that never got a result as failed, or as paused when the turn pauses. */
  const failRunning = (taskId: string, turn: Turn, output: string, state = ToolCallState.Error): void => {
    for (const toolUseId of turn.running.keys()) {
      emitToolEventUpdated(emit, updateToolCall(db, { taskId, toolUseId, state, output }))
    }
    turn.running.clear()
  }

  const onText = (taskId: string, turn: Turn, event: TextEvent): void => {
    const { text, parentToolUseId, sdkUuid } = event
    if (parentToolUseId === null) {
      turn.pending.push({ text, sdkUuid })
      return
    }
    // A subagent's text is the subagent's business, not the chat's: it's what the Agents tab says it's doing.
    if (text.trim() === '') return
    emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: text.trim(), parentToolUseId }))
  }

  /**
   * A call's input as the tool log keeps it. A call that names its todo (an `Agent` call, or the agent's own `Bash`
   * call in the foreground) is read there and then, before its row is written, so a subagent's todo is recorded before
   * the subagent shows, and is logged without the marker, as the tool runs without it (`childStarting`): the marker
   * shows nowhere. Any other call, a watcher's included, is logged as it was written.
   */
  const loggedInput = (taskId: string, event: ToolCallStartedEvent): ToolInput => {
    const { toolUseId, name: toolName, input, parentToolUseId } = event
    const filed =
      filer.callStarting(taskId, { toolName, input, toolUseId, subagent: parentToolUseId !== null }) ?? input
    const model = getTask(db, taskId)?.model
    return isSubagentTool(toolName) &&
      toolName !== DISPATCH_AGENT_TOOL &&
      parentToolUseId === null &&
      model !== undefined &&
      agentSource(model) === AgentSource.OpenRouter
      ? { ...filed, model }
      : filed
  }

  const onToolCall = (taskId: string, turn: Turn, event: ToolCallStartedEvent): void => {
    flushPreamble(taskId, turn)
    const { toolUseId, name, parentToolUseId, sdkUuid } = event
    const input = loggedInput(taskId, event)
    const call = appendToolCall(db, { taskId, turn: turn.number, name, input, toolUseId, parentToolUseId })
    emitToolEventAppended(emit, call)
    turn.running.set(toolUseId, parentToolUseId)
    if (sdkUuid !== null) turn.sdkRows.set(sdkUuid, { id: call.id, toolUseId })
  }

  /**
   * Evicts the turn's own rows a refusal-fallback retry supersedes (see the module comment, and `./events.ts`): any of
   * the turn's not-yet-flushed preamble that named one of `uuids`, and any narration or tool call row already logged
   * for one. Idempotent: a uuid the turn never logged, or already evicted, is a no-op.
   */
  const evictSuperseded = (taskId: string, turn: Turn, uuids: readonly string[]): void => {
    if (uuids.length === 0) return
    const named = new Set(uuids)
    for (let index = turn.pending.length - 1; index >= 0; index--) {
      const sdkUuid = turn.pending[index]?.sdkUuid ?? null
      if (sdkUuid !== null && named.has(sdkUuid)) turn.pending.splice(index, 1)
    }
    for (const uuid of uuids) {
      const row = turn.sdkRows.get(uuid)
      if (row === undefined) continue
      turn.sdkRows.delete(uuid)
      if (row.toolUseId !== null) turn.running.delete(row.toolUseId)
      if (deleteToolEvent(db, taskId, row.id)) emitToolEventRemoved(emit, taskId, row.id)
    }
  }

  /**
   * Sends the session one of Glade's own prompts, remembering it, so the prompt hook knows it for Glade's and never
   * takes it for a wake (`promptVerdict`).
   */
  const give = (live: LiveSession, text: string, uuid: string, images: readonly ImageData[] = []): void => {
    live.handed.push(text)
    live.handed.splice(0, Math.max(0, live.handed.length - MAX_HANDED))
    live.session.send(text, uuid, images)
  }

  /**
   * Whether a prompt about to start a turn goes ahead (the session's prompt hook): one of Glade's own always does, and
   * is forgotten; anything else is a wake, which the watchers count, and turn away if it's a job you stopped.
   */
  const promptVerdict = (taskId: string, live: LiveSession, prompt: string): PromptVerdict => {
    const own = live.handed.indexOf(prompt)
    if (own >= 0) {
      live.handed.splice(own, 1)
      return PromptVerdict.Allow
    }
    if (live.closed) return PromptVerdict.Allow
    const verdict = watchers.prompt(taskId, prompt)
    if (verdict === PromptVerdict.Block) taskLog(taskId).info('stopped watcher fired: turned away')
    return verdict
  }

  /** The root of a task's workspace, as its session runs in it. */
  const rootOf = (taskId: string): string => {
    const task = getTask(db, taskId)
    return (task === undefined ? undefined : getWorkspace(db, task.workspaceId))?.rootPath ?? ''
  }

  /**
   * Hands a user message to the session, with its images, stamped with its id (`uuid`) or a new one's, after `block`
   * when there's one: what the session was missing (`./session-context`).
   */
  const hand = (live: LiveSession, message: Message, uuid: string = message.id, block: string | null = null): void => {
    const root = message.files.length === 0 ? '' : rootOf(message.taskId)
    // The images pasted into it, then those of its attached files the agent takes as images (#396).
    const images = [
      ...imagesOf(db, { kind: ImageOwnerKind.Message, id: message.id }),
      ...attachedImagesOf(root, message.files),
    ]
    // Each pasted block wrapped in its tags, at its token's place among the typed text (#363, `shared/pastedContent.ts`),
    // then a line with the path of each file attached to it (#396, `shared/attachedFiles.ts`).
    const text = withAttachedFiles(agentText(message.body, message.pastedBlocks), message.files, root)
    give(live, withContext(block, text), uuid, images)
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

  /**
   * A `Bash` call's result is in: the change tracker works out, in the background, which commits it made
   * (`../changes/tracker`). A call that failed may have committed before it did, so it counts too.
   */
  const noteBashResult = (taskId: string, call: ToolCallEvent): void => {
    const { command } = call.input
    if (call.name !== BASH_TOOL || typeof command !== 'string') return
    const task = getTask(db, taskId)
    const workspace = task === undefined ? undefined : getWorkspace(db, task.workspaceId)
    if (workspace === undefined) return
    const { toolUseId, output } = call
    void changes.bashFinished(taskId, { toolUseId, command, output: output ?? '', cwd: workspace.rootPath })
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
    if (changesTodos(call)) {
      const { list, changed } = refreshTodos(db, taskId)
      emitTodosChanged(emit, taskId, list)
      if (changed !== null) emitTaskUpdated(emit, changed)
    }
    watchers.toolResult(taskId, call, event)
    noteBashResult(taskId, call)
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
  }

  /**
   * Starts the active task's next turn with its queue, as the end of a turn does (see the module comment). Answers
   * whether it did: false for an empty queue, or a task that's done or gone.
   */
  const startQueued = (taskId: string, live: LiveSession | undefined): boolean => {
    const task = getTask(db, taskId)
    if (task?.state !== TaskState.Active || listQueuedMessages(db, taskId).length === 0) return false
    startTurn(task, live ?? start(task), null)
    return true
  }

  /**
   * Whether the task is stuck with its queue (#441): waiting on you, with no turn running and neither a question nor a
   * permission request open, so nothing is left that would deliver it.
   */
  const holdsQueue = (taskId: string): boolean =>
    getTask(db, taskId)?.activity === TaskActivity.Waiting &&
    (sessions.get(taskId)?.turn ?? null) === null &&
    getOpenQuestionSet(db, taskId) === undefined &&
    !waitsOnRestartRequests(taskId)

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
   * Logs a compaction the SDK reports: fills in its running row, or adds one if the SDK never said it was compacting,
   * with what it carried over (its hook said just before). The context usage drops to what it reports is left.
   */
  const onCompacted = (taskId: string, live: LiveSession, turn: Turn, event: CompactedEvent): void => {
    const task = getTask(db, taskId)
    if (task === undefined) return
    const summary = live.compactSummary
    live.compactSummary = null
    const outcome = { state: ToolCallState.Done, preTokens: event.preTokens, postTokens: event.postTokens, summary }
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

  /**
   * A refused request was retried on a fallback model, which answered (see the module comment): the refused leg's rows
   * the retry supersedes are evicted (idempotent with the eviction each of its own messages already carried), a quiet
   * notice row says so, and, with `scope: 'session'`, the task's model follows the swap, so its picker shows it.
   */
  const onModelRefusalFallback = (
    taskId: string,
    live: LiveSession,
    turn: Turn,
    event: ModelRefusalFallbackEvent,
  ): void => {
    taskLog(taskId).info('refusal answered by fallback model', {
      turn: turn.number,
      originalModel: event.originalModel,
      fallbackModel: event.fallbackModel,
      category: event.category,
      scope: event.scope,
    })
    evictSuperseded(taskId, turn, event.uuids)
    emitToolEventAppended(
      emit,
      appendRefusalFallback(db, {
        taskId,
        turn: turn.number,
        originalModel: event.originalModel,
        fallbackModel: event.fallbackModel,
        category: event.category,
        scope: event.scope,
      }),
    )
    if (event.scope === RefusalScope.Session && getTask(db, taskId)?.model !== event.fallbackModel) {
      // The task's effort follows, as it does for a model the picker changes to: the fallback model's default unless
      // it supports the task's own.
      const switched = updateTaskFromUser(context, taskId, { model: event.fallbackModel })
      live.settings = { ...live.settings, model: switched.model, effort: switched.effort }
      // The init that named the session's model was the refused one's: the next init names the fallback.
      live.sdkModel = null
      live.modelChanged = true
    }
  }

  const onTurnFinished = (taskId: string, live: LiveSession, turn: Turn, event: TurnFinishedEvent): void => {
    failCompaction(turn)
    if (event.isError && (turn.stopping || isAborted(event.terminalReason))) {
      endTurn(taskId, live, turn)
      onTurnStopped(taskId, turn)
      // You stopped the turn, not what you said next: the queue starts the next one, as after any turn (#441).
      if (!startQueued(taskId, live)) setActivity(taskId, TaskActivity.Waiting)
      return
    }
    if (turn.refusal !== null) {
      endTurn(taskId, live, turn)
      onTurnDeclined(taskId, turn)
      return
    }
    if (event.isError) {
      endTurn(taskId, live, turn)
      onTurnFailed(taskId, live, turn, event)
      return
    }
    recovered(taskId, turn)
    const held = turn.pending
      .splice(0)
      .map((part) => part.text)
      .join('\n\n')
      .trim()
    // A turn held at its end for filings owed, whose agent wrote no reply again: the one it had written stands.
    const reply = held === '' ? event.result.trim() || (turn.heldReply ?? '') : held
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
    // A sandbox that couldn't start fails every command: the task stops on it, with its card, rather than carrying on.
    if (turn.sandboxFailure !== null) {
      stopOnError(taskId, sandboxError(turn.sandboxFailure))
      return
    }
    if (!startQueued(taskId, live)) setActivity(taskId, TaskActivity.Waiting)
  }

  /**
   * The turn ended on a safety refusal with no fallback model to retry it on (see the module comment): not a crash,
   * so the task stops on a `TaskError` of its own kind (`AgentErrorKind.SafetyRefusal`), for the chat's declined card
   * and the Needs you reason.
   */
  const onTurnDeclined = (taskId: string, turn: Turn): void => {
    const { refusal } = turn
    if (refusal === null) return
    taskLog(taskId).warn('turn declined by a safety check', { turn: turn.number, category: refusal.category })
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, DECLINED_TOOL_NOTE)
    emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: DECLINED_TOOL_NOTE }))
    const details = refusal.explanation ?? (refusal.content.trim() === '' ? DECLINED_TOOL_NOTE : refusal.content.trim())
    const error: TaskError = {
      kind: AgentErrorKind.SafetyRefusal,
      source: TaskErrorSource.Refusal,
      status: null,
      code: refusal.category,
      details,
      retries: 0,
      retryingMs: 0,
    }
    stopOnError(taskId, error)
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
    const { startupFailureReason } = event
    if (startupFailureReason !== null) {
      // Claude Code couldn't start the session: the card says why, from the reason it named.
      failRunning(taskId, turn, STOPPED_BY_ERROR_NOTE)
      const details = reported === '' ? `Claude Code couldn't start (${startupFailureReason}).` : reported
      emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: details }))
      const failure = { source: TaskErrorSource.Startup, status: null, code: startupFailureReason, details }
      stopOnError(taskId, withRetries(taskId, turn, failure))
      return
    }
    const isApiError = apiError !== null || event.apiErrorStatus !== null || event.terminalReason === 'api_error'
    if (!isApiError) {
      failRunning(taskId, turn, STOPPED_BY_ERROR_NOTE)
      const details = reported === '' ? `The turn failed (${event.terminalReason ?? 'unknown'}).` : reported
      emitToolEventAppended(emit, appendNarration(db, { taskId, turn: turn.number, text: details }))
      stopOnError(
        taskId,
        withRetries(taskId, turn, { source: TaskErrorSource.Turn, status: null, code: null, details }),
      )
      return
    }
    const details = [apiError?.message ?? '', event.result, reported].find((text) => text.trim() !== '') ?? ''
    const error = withRetries(
      taskId,
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

  /**
   * Asks the SDK where it compacts the session automatically (`getContextUsage`, `docs/sdk-notes.md` §5), which follows
   * the user's own Claude Code settings, and keeps it on the task for the context meter. Only for the threshold: its
   * token count runs stale after a compaction, so the meter's comes from the messages. When the SDK can't say, or the
   * task's model changed meanwhile, the last known value stays.
   */
  const refreshAutoCompact = (taskId: string, live: LiveSession): void => {
    const model = getTask(db, taskId)?.model
    live.session.contextUsage().then(
      (raw) => {
        const task = getTask(db, taskId)
        if (live.closed || task === undefined || task.model !== model) return
        const autoCompact = autoCompactFrom(raw)
        if (autoCompact === undefined) {
          agentLog(taskId).warn('the context usage says nothing of auto-compact; keeping the last known')
          return
        }
        if (sameAutoCompact(task.autoCompact, autoCompact)) return
        agentLog(taskId).info('auto-compact changed', { autoCompact })
        updateTaskFromRunner(context, taskId, { autoCompact })
      },
      (error: unknown) => {
        agentLog(taskId).warn('could not read the context usage; keeping the last known', {
          error: describeError(error),
        })
      },
    )
  }

  /**
   * Keeps the context window the result reports for the session's model (`matchReportedWindow`: by the model its init
   * named, the model Glade runs it on or the full id that stands for, else the only one reported, while the session
   * has run on one model), and remembers it for
   * that model under each of those ids, so the next task or model change on it starts from the real size. The task
   * takes it only while it's still on the model the session ran: one the picker changed meanwhile gets its own on its
   * next turn.
   */
  const recordContextWindow = (taskId: string, live: LiveSession, event: TurnFinishedEvent): void => {
    const sessionModel = live.settings.model
    const route = getOpenRouterChoice(db, sessionModel)
    if (route !== undefined) {
      updateTaskFromRunner(context, taskId, {
        contextWindowTokens: live.session.contextWindowTokens ?? taskModelWindow(db, sessionModel),
      })
      return
    }
    const fullId = findModel(offeredModels(db), sessionModel)?.resolvedModel ?? null
    const names = [live.sdkModel, sessionModel, fullId].filter((name) => name !== null)
    const reported = matchReportedWindow(event.contextWindows, names, !live.modelChanged)
    if (reported === undefined) {
      const models = Object.keys(event.contextWindows)
      if (models.length > 0)
        agentLog(taskId).warn("the result reports no window for the session's model", { names, models })
      return
    }
    recordReportedWindow(db, [reported.model, ...names], reported.window)
    const task = getTask(db, taskId)
    if (task?.model !== sessionModel || task.contextWindowTokens === reported.window) return
    agentLog(taskId).info('context window reported', { model: reported.model, window: reported.window })
    updateTaskFromRunner(context, taskId, { contextWindowTokens: reported.window })
  }

  /**
   * Saves how much context the session's prompt fills. More than the task's window holds proves the window wrong: the
   * task then shows the smallest window that holds it (`fitContextWindow`, applied as the task is saved), and the log
   * says so.
   */
  const onContextUsed = (taskId: string, tokens: number): void => {
    const task = getTask(db, taskId)
    if (task === undefined || task.contextUsedTokens === tokens) return
    if (tokens > task.contextWindowTokens) {
      agentLog(taskId).warn('more context used than the window holds; trusting the larger size', {
        used: tokens,
        window: task.contextWindowTokens,
        model: task.model,
      })
    }
    updateTaskFromRunner(context, taskId, { contextUsedTokens: tokens })
  }

  /** A session is gone, and what ran in it with it: it's forgotten, so the next message starts it again. */
  const sessionGone = (taskId: string, live: LiveSession, message: string): void => {
    if (sessions.get(taskId) === live) sessions.delete(taskId)
    // Whatever its calls waited on went with it.
    withdrawRequests(live, true)
    // Its background subagents died with it, and so did its watchers' processes and wakeups.
    for (const toolUseId of [...live.background.keys()]) {
      finishBackground(taskId, live, toolUseId, ToolCallState.Error, message, message)
    }
    watchers.sessionEnded(taskId, message)
    changes.sessionEnded(taskId)
  }

  /**
   * A sandboxed session wouldn't take its overlay (`applySandbox`): since whether its commands ask is in the overlay
   * alone, it can't be left running as it is, so it's closed, and what was held for it is never sent. A turn it was in,
   * or about to start, ends on the sandbox's error, with its card, whose Retry starts a new session. Between turns,
   * the next message starts one. A session already closed or gone is left as it is.
   */
  const onSandboxNotApplied = (taskId: string, live: LiveSession, error: unknown): void => {
    const details = `${SANDBOX_NOT_APPLIED}${describeError(error)}`
    const { turn } = live
    if (live.closed || sessions.get(taskId) !== live) {
      agentLog(taskId).warn("couldn't apply the sandbox's settings to a session that's gone", { error })
      return
    }
    agentLog(taskId).error("couldn't apply the sandbox's settings: session closed", {
      error,
      turn: turn?.number ?? null,
    })
    sessionGone(taskId, live, details)
    live.closed = true
    live.session.close()
    if (turn === null) return
    endTurn(taskId, live, turn)
    failCompaction(turn)
    flushPreamble(taskId, turn)
    failRunning(taskId, turn, details)
    stopOnError(taskId, sandboxError(details))
  }

  /** The session is gone: fail its turn, if one was running, and forget it so the next message starts it again. */
  const onSessionFailed = (taskId: string, live: LiveSession, message: string): void => {
    agentLog(taskId).error('session failed', { message, turn: live.turn?.number ?? null })
    sessionGone(taskId, live, message)
    const { turn } = live
    if (turn === null) return
    endTurn(taskId, live, turn)
    failCompaction(turn)
    turn.pending.push({ text: message, sdkUuid: null })
    flushPreamble(taskId, turn)
    const error = withRetries(taskId, turn, {
      source: TaskErrorSource.Session,
      status: null,
      code: null,
      details: message,
    })
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
      const { toolUseId, name } = event
      const input = loggedInput(taskId, event)
      emitToolEventAppended(emit, appendToolCall(db, { taskId, turn, name, input, toolUseId, parentToolUseId }))
      live.backgroundCalls.set(toolUseId, owner)
      return true
    }
    if (event.kind !== AgentEventKind.ToolResult || !live.backgroundCalls.delete(event.toolUseId)) return false
    if (live.background.has(event.toolUseId)) return true
    live.subagents.delete(event.toolUseId)
    const state = event.isError ? ToolCallState.Error : ToolCallState.Done
    const call = updateToolCall(db, { taskId, toolUseId: event.toolUseId, state, output: event.output })
    emitToolEventUpdated(emit, call)
    watchers.toolResult(taskId, call, event)
    noteBashResult(taskId, call)
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

  /**
   * A subagent that had finished runs again (#395): its `Agent` call's row goes back to running, keeping its log, and
   * it's followed as a background subagent until its run ends, as the SDK registers a woken subagent in the background.
   * Its calls and notes are logged with the turn its `Agent` call was made in. `by` is the call the SDK reports the run
   * under: the waking `SendMessage`, or the `Agent` call itself when the SDK starts it again on its own.
   */
  const wakeSubagent = (taskId: string, live: LiveSession, call: ToolCallEvent, by: SubagentWake): void => {
    const { toolUseId } = call
    taskLog(taskId).info('subagent woken', { toolUseId, by: by.toolUseId, sdkTaskId: by.sdkTaskId })
    if (by.toolUseId !== toolUseId) live.woken.set(by.toolUseId, toolUseId)
    live.subagents.set(toolUseId, by.sdkTaskId)
    const reopened = reopenSubagentCall(db, taskId, toolUseId)
    if (reopened !== undefined) emitToolEventUpdated(emit, reopened)
    runInBackground(live, toolUseId, call.turn)
  }

  /**
   * A subagent's task started (`task_started`, `local_agent`): its `Agent` call keeps the SDK's id for it, and one that
   * had finished is woken again (`docs/sdk-notes.md`, "Subagents woken again"): by its own `Agent` call, started again
   * by the SDK, or by the agent's `SendMessage`, found by its SDK task id. Answers whether that's what it was; a first
   * start is handled like any task's.
   */
  const onSubagentTask = (taskId: string, live: LiveSession, event: SubagentStartedEvent): boolean => {
    const { toolUseId, sdkTaskId } = event
    const call = getToolCall(db, taskId, toolUseId)
    if (call !== undefined && isSubagentTool(call.name)) {
      setSubagentTaskId(db, { taskId, toolUseId, sdkTaskId })
      if (call.state === ToolCallState.Running) return false
      wakeSubagent(taskId, live, call, event)
      return true
    }
    const subagent = findSubagentCall(db, taskId, sdkTaskId)
    if (subagent !== undefined) {
      wakeSubagent(taskId, live, subagent, event)
      return true
    }
    if (call?.name !== SEND_MESSAGE_TOOL) return false
    taskLog(taskId).info('subagent woken, not yet known', { by: toolUseId, sdkTaskId })
    live.unknownWakes.set(sdkTaskId, toolUseId)
    return true
  }

  /**
   * A message from inside a subagent, while a `SendMessage` has woken one Glade doesn't know by its SDK task id: the
   * message's `Agent` call, if it had finished, is the subagent that woke (the oldest such wake), and it's known from now.
   */
  const bindUnknownWake = (taskId: string, live: LiveSession, parentToolUseId: string | null): void => {
    const [wake] = live.unknownWakes
    if (wake === undefined || parentToolUseId === null || backgroundOwner(live, parentToolUseId) !== undefined) return
    const call = getToolCall(db, taskId, parentToolUseId)
    if (call === undefined || !isSubagentTool(call.name) || call.state === ToolCallState.Running) return
    const [sdkTaskId, toolUseId] = wake
    live.unknownWakes.delete(sdkTaskId)
    setSubagentTaskId(db, { taskId, toolUseId: call.toolUseId, sdkTaskId })
    wakeSubagent(taskId, live, call, { toolUseId, sdkTaskId })
  }

  /**
   * A subagent was stopped: the monitors and commands it leaves running end with it, and their tasks are stopped, in
   * case the SDK leaves them running.
   */
  const onSubagentStopped = (taskId: string, live: LiveSession, toolUseId: string): void => {
    for (const sdkTaskId of watchers.subagentStopped(taskId, toolUseId)) {
      taskLog(taskId).info("stopping a stopped subagent's watcher", { toolUseId, sdkTaskId })
      live.session.stopTask(sdkTaskId).catch((error: unknown) => {
        taskLog(taskId).warn("couldn't stop a stopped subagent's watcher", { sdkTaskId, error })
      })
    }
  }

  /**
   * Keeps the MCP servers a session named for its workspace, for Settings to offer (`reported_mcp_servers`): only the
   * ones new to the session, or named otherwise than it last named them.
   */
  const noteServers = (taskId: string, live: LiveSession, servers: readonly ReportedMcpServer[]): void => {
    const news = servers.filter(({ server, name }) => live.reported.get(server) !== name)
    if (news.length === 0) return
    for (const { server, name } of news) live.reported.set(server, name)
    const kept = news.map(({ server, name }) => ({ server, name }))
    const changed = noteReportedServers(db, live.owner.workspaceId, kept)
    agentLog(taskId).info('mcp servers reported', { servers: kept.map(({ server }) => server), changed })
  }

  const onEvent = (taskId: string, live: LiveSession, event: AgentEvent): void => {
    if (live.closed) return
    if (event.kind === AgentEventKind.ToolCallStarted) live.callParents.set(event.toolUseId, event.parentToolUseId)
    if (event.kind === AgentEventKind.ToolResult) live.callParents.delete(event.toolUseId)
    if (event.kind === AgentEventKind.SessionStarted) {
      live.sdkModel = event.model
      if (getTask(db, taskId)?.model === live.settings.model && live.session.contextWindowTokens !== undefined)
        updateTaskFromRunner(context, taskId, { contextWindowTokens: live.session.contextWindowTokens })
      if (getTask(db, taskId)?.model === live.settings.model) recordSwitch(taskId, live.settings.model)
      if (getTask(db, taskId)?.sessionId !== event.sessionId) {
        agentLog(taskId).info('session id saved', { sessionId: event.sessionId, model: event.model })
        updateTaskFromRunner(context, taskId, { sessionId: event.sessionId })
      }
      return
    }
    if (event.kind === AgentEventKind.McpServersReported) {
      // A CLI that doesn't say where a server came from names Glade's own too: those aren't anyone's to grant.
      noteServers(
        taskId,
        live,
        event.servers.filter(({ source, reportedName }) => source !== null || !live.inProcess.includes(reportedName)),
      )
      return
    }
    if (event.kind === AgentEventKind.SessionFailed) {
      onSessionFailed(taskId, live, event.message)
      return
    }
    if (event.kind === AgentEventKind.RateLimit) {
      if (agentSource(live.settings.model) === AgentSource.OpenRouter) return
      agentLog(taskId).info('rate limit', {
        status: event.status,
        resetsAt: event.resetsAt,
        utilization: event.utilization,
        window: event.window,
      })
      const rejected = event.status === RateLimitStatus.Rejected
      live.limit = { rejected, resetsAt: event.resetsAt, limit: limitOfWindow(event.window) }
      options.account?.rateLimit(event)
      return
    }
    if (event.kind === AgentEventKind.SubagentStarted) {
      const { toolUseId, sdkTaskId, taskType, isBackgrounded } = event
      taskLog(taskId).info('task started', { toolUseId, sdkTaskId, taskType, isBackgrounded })
      if (taskType === SUBAGENT_TASK && onSubagentTask(taskId, live, event)) return
      live.subagents.set(event.toolUseId, event.sdkTaskId)
      watchers.taskStarted(taskId, event, live.callParents.get(toolUseId) ?? null)
      if (event.background) {
        runInBackground(live, event.toolUseId, live.turn?.number ?? Math.max(1, lastTurn(db, taskId)))
      }
      return
    }
    if (event.kind === AgentEventKind.SubagentBackgrounded) {
      watchers.taskBackgrounded(taskId, event.sdkTaskId)
      for (const [toolUseId, sdkTaskId] of live.subagents) {
        if (sdkTaskId === event.sdkTaskId && live.turn?.running.get(toolUseId) === null) {
          runInBackground(live, toolUseId, live.turn.number)
        }
      }
      return
    }
    if (event.kind === AgentEventKind.SubagentProgress) {
      // Kept on its `Agent` call while it runs; one that arrives after its subagent finished changes nothing.
      const { summary } = event
      const toolUseId = live.woken.get(event.toolUseId) ?? event.toolUseId
      const call = setSubagentProgress(db, { taskId, toolUseId, summary })
      if (call === undefined) return
      taskLog(taskId).debug('subagent progress', { toolUseId, summary })
      emitToolEventUpdated(emit, call)
      return
    }
    if (event.kind === AgentEventKind.TaskFinished) {
      // A woken subagent's run ends under the call that woke it: it's its `Agent` call's subagent that ended.
      live.unknownWakes.delete(event.sdkTaskId)
      const subagent = live.woken.get(event.toolUseId)
      live.woken.delete(event.toolUseId)
      const finished = subagent === undefined ? event : { ...event, toolUseId: subagent }
      watchers.taskFinished(taskId, finished)
      if (
        finished.outcome === TaskOutcome.Stopped ||
        getToolCall(db, taskId, finished.toolUseId)?.name === DISPATCH_AGENT_TOOL
      )
        onSubagentStopped(taskId, live, finished.toolUseId)
      onTaskFinished(taskId, live, finished)
      return
    }
    if (event.kind === AgentEventKind.Text || event.kind === AgentEventKind.ToolCallStarted) {
      bindUnknownWake(taskId, live, event.parentToolUseId)
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
        markRuled(taskId, live, event)
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
        onContextUsed(taskId, event.tokens)
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
        onCompacted(taskId, live, turn, event)
        return
      case AgentEventKind.CompactionFailed:
        taskLog(taskId).warn('compaction failed', { turn: turn.number })
        // Whatever its hook said isn't carried over.
        live.compactSummary = null
        failCompaction(turn)
        return
      case AgentEventKind.MessagesEvicted:
        evictSuperseded(taskId, turn, event.uuids)
        return
      case AgentEventKind.ModelRefusalFallback:
        onModelRefusalFallback(taskId, live, turn, event)
        return
      case AgentEventKind.ModelRefusalNoFallback:
        taskLog(taskId).warn('declined by a safety check, no fallback', { turn: turn.number, category: event.category })
        turn.refusal = { category: event.category, explanation: event.explanation, content: event.content }
        return
      case AgentEventKind.TurnFinished: {
        const { isError, terminalReason, durationMs, totalCostUsd, usage } = event
        const fields = {
          turn: turn.number,
          isError,
          terminalReason,
          durationMs,
          totalCostUsd: agentSource(live.settings.model) === AgentSource.OpenRouter ? null : totalCostUsd,
          usage,
        }
        if (isError) taskLog(taskId).warn('turn result', fields)
        else taskLog(taskId).info('turn result', fields)
        recordContextWindow(taskId, live, event)
        // A compaction reports done before its turn's result: a summary still here belongs to none.
        live.compactSummary = null
        onTurnFinished(taskId, live, turn, event)
        refreshAutoCompact(taskId, live)
        readUsage(taskId, live)
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
    const { sandbox } = live
    // The session's hook decided this call before Claude Code asked about it: the same answer, and no second card.
    const started = sandbox?.started.get(toolUseId)
    if (sandbox !== null && started !== undefined) {
      sandbox.started.delete(toolUseId)
      taskLog(taskId).debug('tool call answered as its hook decided', { toolName, toolUseId })
      return started
    }
    const { verdict, crossing } = toolCallVerdict(call, {
      permissionMode,
      gladeServers: live.gladeServers,
      sandbox: sandbox === null ? null : { bounds: sandbox.bounds, failed: sandbox.failure !== null },
      writeRules: sandbox === null ? [] : [...sandbox.writeRules],
    })
    switch (verdict) {
      case PermissionVerdict.Allow:
        taskLog(taskId).debug('tool call allowed without asking', { toolName, toolUseId, permissionMode })
        return ALLOWED_WITHOUT_ASKING
      case PermissionVerdict.Refuse:
        taskLog(taskId).info('tool call refused by the sandbox', { toolName, toolUseId, agentId, crossing })
        return refusalFor(crossing)
      case PermissionVerdict.Ask:
        break
    }
    if (live.closed) return WITHDRAWN
    const allowed = takeRestartAllowance(taskId, call)
    if (allowed !== undefined) {
      taskLog(taskId).info('tool call allowed after a restart', { requestId: allowed.id, toolName, toolUseId })
      const rule = allowed.grantedRule
      return sessionAnswer(live, {
        behavior: ToolPermissionBehavior.Allow,
        byUser: true,
        ...(rule === null ? {} : { rule }),
      })
    }
    // A connection's request names no call: it goes with the command running now, on its row, as its subagent's.
    const command = sandbox !== null && toolName === SANDBOX_NETWORK_TOOL ? await commandBehind(taskId) : null
    // The session may have closed while the command was looked for.
    if (sessions.get(taskId) !== live) return WITHDRAWN
    const ask = sandbox === null ? null : sandboxAskFor(call, crossing, sandbox.bounds, command)
    if (sandbox !== null && toolName === SANDBOX_NETWORK_TOOL && ask === null) {
      taskLog(taskId).info('connection refused: no card can name its host', { toolUseId, host: call.input.host })
      return CONNECTION_REFUSED
    }
    const asking = command?.toolUseId ?? toolUseId
    const denied = ask === null ? undefined : deniedEarlier(taskId, turnOf(taskId, live, asking), ask)
    if (denied !== undefined) {
      taskLog(taskId).info('denied as earlier in the turn', { toolName, toolUseId, requestId: denied.id })
      return { behavior: ToolPermissionBehavior.Deny, message: alreadyDeniedMessage(denied.denyNote), byUser: false }
    }
    // A card for an MCP server or for other agents answers for every call that needs the same: they wait on it.
    const shared = sandbox === null ? null : sharedCardKey(ask)
    const settle = sandbox === null || shared === null ? null : holdCard(sandbox, shared)
    try {
      const { request, decision } = await requested(
        taskId,
        live,
        {
          toolUseId: asking,
          agentId: agentId ?? command?.parentToolUseId ?? null,
          toolName,
          input: call.input,
          title: call.title,
          displayName: call.displayName,
          description: call.description,
          suggestions: call.suggestions,
          defaultToNo: call.defaultToNo,
          // Nothing that crosses the sandbox's bounds is ever remembered as a rule: the rule Allow for this task would
          // grant is the whole tool, for every folder. A folder or domain is granted instead, by its own card.
          suppressAlwaysAllowRule: call.suppressAlwaysAllowRule || crossing !== SandboxCrossing.None,
          sandbox: ask,
        },
        call.signal,
      )
      if (decision === null || !(await applyGrant(taskId, live, grantedScope(decision, request)))) return WITHDRAWN
      carryOn(taskId, live)
      return sessionAnswer(live, answerFor(decision, request))
    } finally {
      settle?.()
    }
  }

  /**
   * Notes that a card is open for what `key` names (`sharedCardKey`), for the calls that need the same to wait on.
   * Answers what settles it, once the card is answered or withdrawn and any grant is in force.
   */
  const holdCard = (sandbox: LiveSandbox, key: string): (() => void) => {
    let settled = (): void => undefined
    const open = new Promise<void>((resolve) => {
      settled = resolve
    })
    sandbox.asking.set(key, open)
    return () => {
      if (sandbox.asking.get(key) === open) sandbox.asking.delete(key)
      settled()
    }
  }

  /**
   * How a call to a tool that may reach outside the sandbox stands, before anyone is asked (#515): left to Claude
   * Code (null) when it uses nothing there (one of Glade's own servers' tools, a message to the task's own subagent),
   * or what it uses is granted; to be decided (undefined) when it isn't. A card already open for the same server or
   * agents, another call's, is waited for first: its answer may grant this call too, or deny it for the turn. If that
   * card is withdrawn instead (its own call was cancelled), this call asks for itself.
   */
  const outsideStanding = async (
    taskId: string,
    live: LiveSession,
    sandbox: LiveSandbox,
    call: ToolCallStarting,
  ): Promise<ToolStartDecision | null | undefined> => {
    const use = outsideUse(call, sandbox.bounds)
    if (use === null) return null
    // A server a call names is one its workspace's sessions have reported, whether or not an init listed it.
    if (use.kind === SandboxGrantKind.McpServer && call.mcpServer !== null) {
      noteServers(taskId, live, [{ server: use.server, name: use.name }])
    }
    const key = sharedCardKey(outsideAsk(use))
    for (let open = cardOpenFor(sandbox, key); open !== undefined; open = cardOpenFor(sandbox, key)) {
      await open
      // The call was cancelled meanwhile, or its turn is being stopped: it never asks for itself. A background
      // subagent's call isn't the turn's, and carries on.
      const stopping = live.turn?.stopping === true && !live.backgroundCalls.has(call.toolUseId)
      if (live.closed || call.signal.aborted || stopping) return WITHDRAWN
    }
    if (!isGrantedUse(use, sandbox.bounds)) return undefined
    markGrantedUse(taskId, live, sandbox, call.toolUseId, use)
    return null
  }

  /** The card open in a session for what `key` names; undefined for none, and for a call no card is shared for. */
  const cardOpenFor = (sandbox: LiveSandbox, key: string | null): Promise<void> | undefined =>
    key === null ? undefined : sandbox.asking.get(key)

  /**
   * Marks a call a grant let through to something outside the sandbox: whose grant, and what for. In the ask mode it
   * isn't marked: the call is decided next, on a card of its own or by a task rule, and its row says that.
   */
  const markGrantedUse = (
    taskId: string,
    live: LiveSession,
    sandbox: LiveSandbox,
    toolUseId: string,
    use: OutsideUse,
  ): void => {
    if (live.settings.permissionMode !== PermissionMode.AllowAll) return
    const ask = outsideAsk(use)
    const granting = grantingGrant(heldBy(live, sandbox), use)
    if (ask !== null && granting !== null) {
      mark(taskId, toolUseId, { kind: PermissionMarkKind.Grant, scope: granting.scope, ask })
    }
  }

  /**
   * A sandboxed session's call to a tool the sandbox bounds, or one that reaches outside it (#515), is about to run
   * (its `PreToolUse` hook, #514): decides it
   * here when it crosses the bounds, before any of Claude Code's rules can let it through, and leaves every other call
   * to Claude Code (null), which asks about it as it always has (`decideToolCall`). A crossing is decided as
   * `decideToolCall` decides one: refused, or asked about on its card, however long you take. A call let through is
   * remembered, so Claude Code asking about it afterwards gets the same answer.
   */
  const toolStarting = async (
    taskId: string,
    live: LiveSession,
    call: ToolCallStarting,
  ): Promise<ToolStartDecision | null> => {
    const { sandbox } = live
    if (sandbox === null || live.closed) return null
    const { toolName, input, toolUseId, agentId, signal, mcpServer } = call
    if (isOutsideTool(toolName)) {
      const standing = await outsideStanding(taskId, live, sandbox, call)
      if (standing !== undefined) return standing
    } else if (sandboxCrossing({ toolName, input }, sandbox.bounds) === SandboxCrossing.None) {
      // The one thing done for every such call: where its path really is, or whether its command leaves the sandbox.
      return null
    }
    const answer = await decideToolCall(taskId, live, {
      toolName,
      input,
      toolUseId,
      agentId,
      title: null,
      displayName: toolName,
      description: null,
      suggestions: [],
      defaultToNo: false,
      suppressAlwaysAllowRule: true,
      mcpServer,
      matchedAskRule: false,
      blockedPath: null,
      decisionReason: null,
      signal,
    })
    // Never a rule: nothing that crosses the bounds is remembered as one.
    const decision: ToolStartDecision =
      answer.behavior === ToolPermissionBehavior.Allow ? { behavior: answer.behavior, byUser: answer.byUser } : answer
    if (decision.behavior === ToolPermissionBehavior.Allow) {
      sandbox.started.set(toolUseId, decision)
      for (const [oldest] of sandbox.started) {
        if (sandbox.started.size <= MAX_HANDED) break
        sandbox.started.delete(oldest)
      }
    }
    return decision
  }

  /**
   * The turn a call's permission request belongs to: a background subagent's call, the turn its `Agent` call was made
   * in; any other, the turn running.
   */
  const turnOf = (taskId: string, live: LiveSession, toolUseId: string): number => {
    const owner = live.backgroundCalls.get(toolUseId)
    return (owner === undefined ? live.turn?.number : live.background.get(owner)) ?? Math.max(1, lastTurn(db, taskId))
  }

  /**
   * Your denial, earlier in a turn, of the folder or domain a call now asks for (see the module comment): the latest,
   * or undefined when you haven't denied it this turn. Running outside the sandbox asks every time. A request Glade
   * itself closed denied, because its folder moved under its card (`FOLDER_MOVED_NOTE`), isn't yours: it may ask again.
   */
  const deniedEarlier = (taskId: string, turn: number, ask: SandboxAsk): PermissionRequest | undefined => {
    if (ask.kind === SandboxAskKind.Outside) return undefined
    return listPermissionRequests(db, taskId).findLast(
      (request) =>
        request.turn === turn &&
        request.state === PermissionRequestState.Denied &&
        request.denyNote !== FOLDER_MOVED_NOTE &&
        deniedCovers(request.sandbox, ask),
    )
  }

  /**
   * Opens a permission request for a call of the session's and waits on it, however long it takes: your decision, or
   * null once it's withdrawn.
   */
  const requested = async (
    taskId: string,
    live: LiveSession,
    call: Omit<NewPermissionRequest, 'taskId' | 'turn'>,
    signal: AbortSignal | undefined,
  ): Promise<DecidedRequest> => {
    const { toolUseId, toolName, agentId } = call
    const turn = turnOf(taskId, live, toolUseId)
    const pending = permissions.request({ ...call, taskId, turn }, signal)
    const requestId = pending.request.id
    const asks = call.sandbox?.kind ?? null
    taskLog(taskId).info('permission requested', { requestId, toolName, toolUseId, agentId, turn, asks })
    live.requests.set(requestId, live.backgroundCalls.has(toolUseId))
    const decision = await pending.decision
    live.requests.delete(requestId)
    // The answer may have granted the task a rule.
    live.rules = null
    if (decision === null) taskLog(taskId).info('permission withdrawn', { requestId, toolUseId })
    else taskLog(taskId).info('permission answered', { requestId, toolUseId, decision: decision.kind })
    return { request: pending.request, decision }
  }

  /** The turn carries on after an answer, unless it's over or stopping, or something else still waits on you. */
  const carryOn = (taskId: string, live: LiveSession): void => {
    const running = live.turn !== null && !live.turn.stopping && !live.closed
    if (running && !waitsOnYou(taskId)) setActivity(taskId, TaskActivity.Working)
  }

  /**
   * Applies the grant an answer made, saved with it, to the running sessions it covers, and resolves once the asking
   * task's session has it (the others apply in the background): the call it lets through, and the agent's retry, then
   * find it in force. Resolves false when that session wouldn't take it, and was closed. With no grant, true at once.
   */
  const applyGrant = async (taskId: string, live: LiveSession, scope: CardGrantScope | null): Promise<boolean> => {
    const task = getTask(db, taskId)
    if (scope === null || task === undefined) return true
    await runner.applySandboxGrants(cardGrantTarget(scope, task), { awaitTaskId: taskId })
    return !live.closed
  }

  /** Records what a rule decided of a tool call, and tells the windows of that call's mark when it's news. */
  const mark = (taskId: string, toolUseId: string, outcome: PermissionMarkOutcome): void => {
    const marked = setPermissionMark(db, { taskId, toolUseId, outcome })
    if (marked !== undefined) emitPermissionMarked(emit, marked)
  }

  /**
   * Marks a call a rule decides, as it starts (see the module comment): one the sandbox refuses for its credential
   * path, one a grant covers, or, in the ask mode, one a task rule covers. Any other call is left unmarked, and so is
   * every call that crosses the sandbox's bounds: it's asked about, or refused, whatever rule covers it.
   */
  const markRuled = (
    taskId: string,
    live: LiveSession,
    call: Pick<ToolCallStartedEvent, 'toolUseId' | 'name' | 'input'>,
  ): void => {
    const outcome = ruledOutcome(taskId, live, call.name, call.input)
    if (outcome !== null) mark(taskId, call.toolUseId, outcome)
  }

  /** What a rule decides of a call as it starts; null when none decides anything of it. */
  const ruledOutcome = (
    taskId: string,
    live: LiveSession,
    toolName: string,
    input: ToolInput,
  ): PermissionMarkOutcome | null => {
    const { sandbox } = live
    if (sandbox !== null) {
      // The path is resolved here, once, as the classifier would for `canUseTool`.
      const { crossing, key } = callStanding({ toolName, input }, sandbox.bounds)
      const refused = crossing === SandboxCrossing.Credential || crossing === SandboxCrossing.Unresolvable
      const named = refused ? fileToolPath({ toolName, input }, sandbox.bounds) : null
      if (named !== null) return { kind: PermissionMarkKind.Blocked, ask: { kind: SandboxAskKind.Folder, ...named } }
      if (crossing !== SandboxCrossing.None) return null
      const granted = grantOutcome(live, sandbox, toolName, input, key)
      if (granted !== null) return granted
    }
    return ruleOutcome(live, taskId, toolName, input)
  }

  /** Every grant that covers a session's task, with its scope: read once, and again when its grants change. */
  const heldBy = (live: LiveSession, sandbox: LiveSandbox): readonly GrantingGrant[] =>
    (sandbox.held ??= heldGrants(db, live.owner))

  /**
   * Whose grant lets a file tool's or `WebFetch`'s call through, inside the bounds as it is; null when no grant is
   * needed for it. `key` is the key of the path a file tool's call names.
   */
  const grantOutcome = (
    live: LiveSession,
    sandbox: LiveSandbox,
    toolName: string,
    input: ToolInput,
    key: string | null,
  ): PermissionMarkOutcome | null => {
    if (toolName === 'WebFetch') {
      const host = fetchedHost(input)
      const use = { kind: SandboxGrantKind.Domain, domain: host ?? '' } as const
      const granting = host === null ? null : grantingGrant(heldBy(live, sandbox), use)
      if (host === null || granting === null) return null
      const ask: SandboxGrantAsk = {
        kind: SandboxAskKind.Domain,
        domain: host,
        command: null,
        commandDescription: null,
      }
      return { kind: PermissionMarkKind.Grant, scope: granting.scope, ask }
    }
    // A call in the workspace root needs no grant, and most calls are: nothing is looked up for one.
    if (key === null || keyInside(key, sandbox.bounds.readable[0] ?? key)) return null
    const access = isWriteTool(toolName) ? FolderAccess.ReadWrite : FolderAccess.Read
    const granting = grantingGrant(heldBy(live, sandbox), { kind: SandboxGrantKind.Folder, key, access })
    if (granting?.grant.kind !== SandboxGrantKind.Folder) return null
    return { kind: PermissionMarkKind.Grant, scope: granting.scope, ask: grantedAsk(granting.grant, access) }
  }

  /** The task rule that lets a call through in the ask mode, as its mark; null in Allow all, and when none covers it. */
  const ruleOutcome = (
    live: LiveSession,
    taskId: string,
    toolName: string,
    input: ToolInput,
  ): PermissionMarkOutcome | null => {
    if (live.settings.permissionMode !== PermissionMode.AskBeforeEdits) return null
    live.rules ??= listTaskPermissionRules(db, taskId).map(({ rule }) => rule)
    const covering = live.rules.find((rule) => ruleCovers(rule, toolName, input))
    return covering === undefined ? null : { kind: PermissionMarkKind.TaskRule, rule: covering }
  }

  /**
   * The command the sandbox blocked that a `request_access` call asks about: the call the same agent (the task's own,
   * or the same subagent) made just before it, when the sandbox blocked that and nothing has said what of yet. Null
   * when the call before was anything else, or the `request_access` call itself isn't logged.
   */
  const blockedJustBefore = (taskId: string, toolUseId: string): string | null => {
    const before = previousToolCall(db, taskId, toolUseId)
    const outcome = before === undefined ? undefined : getPermissionMark(db, taskId, before.toolUseId)?.outcome
    return before !== undefined && outcome?.kind === PermissionMarkKind.Blocked && outcome.ask === null
      ? before.toolUseId
      : null
  }

  /**
   * The command running in a task now, the latest started when several are: the one a connection's request is put on,
   * since the SDK doesn't say which command made it (`docs/sdk-notes.md` §15). Null when none is running.
   */
  const runningCommand = (taskId: string): RunningCommand | null => {
    const call = listToolCallsNamed(db, taskId, COMMAND_TOOL_NAMES).findLast(
      ({ state }) => state === ToolCallState.Running,
    )
    const command = call?.input.command
    if (call === undefined || typeof command !== 'string') return null
    const { description } = call.input
    return {
      toolUseId: call.toolUseId,
      command,
      description: typeof description === 'string' ? description : null,
      parentToolUseId: call.parentToolUseId,
    }
  }

  /**
   * The command a connection's request is put on (`runningCommand`). The request can reach Glade ahead of the
   * command's own `tool_use`, which comes through the session's stream: one not logged yet is given a moment to be.
   */
  const commandBehind = async (taskId: string): Promise<RunningCommand | null> => {
    for (let tick = 0; tick < COMMAND_TICKS && runningCommand(taskId) === null; tick += 1) await Promise.resolve()
    return runningCommand(taskId)
  }

  /**
   * Which `request_access` call a handler answers, and whose: the one the session's hook told of (`onAccessRequested`)
   * under the id Claude Code sent with the request, or, when it sent none, the oldest one for the same path and access
   * that no handler has picked up. A call the hook never told of is taken for the agent's own, under an id of its own.
   */
  const accessCaller = (
    live: LiveSession,
    request: AccessRequest,
    toolUseId: string | null,
  ): Pick<AccessCallStarting, 'toolUseId' | 'agentId'> => {
    const index = live.accessCalls.findIndex(({ toolUseId: id, input }) =>
      toolUseId === null
        ? typeof input.path === 'string' && input.path.trim() === request.path && input.access === request.access
        : id === toolUseId,
    )
    const [started] = index < 0 ? [] : live.accessCalls.splice(index, 1)
    return started ?? { toolUseId: toolUseId ?? `request_access-${randomUUID()}`, agentId: null }
  }

  /**
   * An answer as the session gets it. A sandboxed session is never handed a rule for a whole tool the sandbox bounds
   * (`isUnboundedRule`): Claude Code would take it for every folder, so the task keeps the rule, and Glade decides the
   * calls it covers itself (`toolCallVerdict`).
   */
  const sessionAnswer = (live: LiveSession, answer: ToolPermissionAnswer): ToolPermissionAnswer => {
    const { sandbox } = live
    if (sandbox === null || answer.behavior !== ToolPermissionBehavior.Allow) return answer
    const { rule, ...once } = answer
    if (rule === undefined || !isUnboundedRule(rule)) return answer
    if (isWriteTool(rule.toolName)) sandbox.writeRules.add(rule.toolName)
    return once
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

  /**
   * Lets the session's messages streamed before a hook was called be handled first: the hook's answer reads what they
   * wrote (the todo list, the tool log, the watchers). The SDK hands a hook its call after the messages before it, and
   * every one of those is handled before a macrotask runs.
   */
  const caughtUp = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve)
    })

  /**
   * A call a todo is read off is about to run, in a session with the todo hub (see the module comment): an `Agent`
   * call, or the agent's own `Bash` call in the foreground. What it makes is filed under the todo it names, and it runs
   * without the marker.
   */
  const childStarting = async (
    taskId: string,
    live: LiveSession,
    { toolName, input, toolUseId, agentId }: ChildCallStarting,
  ): Promise<ToolInput | null> => {
    if (live.closed) return null
    // A todo made by an earlier call of the same message is in the task's list once that call's result has been
    // handled, which may be after this call streamed.
    if (namedTodo(toolName, input) !== null) await caughtUp()
    return filer.callStarting(taskId, { toolName, input, toolUseId, subagent: agentId !== null })
  }

  /**
   * The calls of one of the agent's own messages have run, in a session with the todo hub: the subagents and commits
   * they made that are under no todo are what the agent is told to file, with their results. A `Bash` call's commits
   * are waited for first. A watcher's call is passed over: nothing is said of it.
   */
  const batchFinished = async (taskId: string, live: LiveSession, batch: ToolBatch): Promise<string | null> => {
    const calls = batch.calls.filter(({ toolName, input }) => readsTodo({ toolName, input, subagent: false }))
    // A function, so the check isn't narrowed away: the session can close during either wait.
    const isClosed = (): boolean => live.closed
    if (isClosed() || calls.length === 0) return null
    await caughtUp()
    const cwd = rootOf(taskId)
    await Promise.all(
      calls.flatMap(({ toolName, toolUseId, input: { command }, output }) =>
        toolName === BASH_TOOL && typeof command === 'string'
          ? [changes.bashFinished(taskId, { toolUseId, command, output, cwd })]
          : [],
      ),
    )
    if (isClosed()) return null
    const asked = filer.batchFinished(
      taskId,
      calls.map(({ toolUseId }) => toolUseId),
    )
    if (asked !== null) taskLog(taskId).info('asked the agent to file what it made', { calls: calls.length })
    return asked
  }

  /**
   * The agent is about to end its turn, in a session with the todo hub: with a filing owed, the end is held, and the
   * reply it had written goes to the tool log, since it writes its reply again once it has filed; it's kept too, for
   * a turn whose agent files and writes nothing more. A turn you stopped ends, and so does a compaction, which is no
   * turn of the agent's.
   */
  const turnEnding = async (taskId: string, live: LiveSession, ending: TurnEnding): Promise<string | null> => {
    await caughtUp()
    const { turn } = live
    if (live.closed || turn === null || turn.stopping || turn.compactOnly) return null
    const reason = filer.turnEnding(taskId, ending.held)
    if (reason === null) return null
    taskLog(taskId).info('turn end held: filings owed', { turn: turn.number, heldBefore: ending.held })
    const written = turn.pending
      .map((part) => part.text)
      .join('\n\n')
      .trim()
    if (written !== '') turn.heldReply = written
    flushPreamble(taskId, turn)
    return reason
  }

  const switching = new Set<string>()
  const preparing = new Map<string, LiveSession>()
  const deferredPauses = new Set<string>()
  const recordSwitch = (taskId: string, model: string): void => {
    const event = completeModelSwitch(db, taskId, model, lastTurn(db, taskId))
    if (event !== null) emitToolEventAppended(emit, event)
  }
  const activate = (task: Task, live: LiveSession): void => {
    sessions.set(task.id, live)
    void pump(task.id, live)
    readAccount(task.id, live)
    readUsage(task.id, live)
  }
  const start = (task: Task, provisional = false): LiveSession => {
    const workspace = getWorkspace(db, task.workspaceId)
    if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${task.workspaceId}`)
    const settings = getSettings(db)
    // The sandbox, when on, is the session's for its whole life: a change to the setting applies from its next start.
    const sandboxed = settings.sandboxEnabled
    // Whatever calls the task's last session was running went with it.
    if (!provisional) filer.sessionEnded(task.id)
    const taskRules = listTaskPermissionRules(db, task.id).map(({ rule }) => rule)
    // A sandboxed session isn't told of a rule for a whole tool the sandbox bounds: Claude Code would take it for every
    // folder. Glade decides those calls itself (`toolCallVerdict`).
    const allowedRules = sandboxed ? taskRules.filter((rule) => !isUnboundedRule(rule)) : taskRules
    const writeRules = taskRules.filter((rule) => isUnboundedRule(rule) && isWriteTool(rule.toolName))
    agentLog(task.id).info(task.sessionId === null ? 'session starting' : 'session resuming', {
      model: task.model,
      effort: task.effort,
      permissionMode: task.permissionMode,
      allowedRules: allowedRules.length,
      sandboxed,
      cwd: workspace.rootPath,
      resumeSessionId: task.sessionId,
    })
    const servers = mcpServers(task)
    const control = CONTROL_SERVER in servers
    const handoff = getHandoff(db, task.id) ?? null
    // A session Glade starts has everything its prompt says; one it resumes keeps the prompt it started with, and is
    // sent what it's missing with its next message (`startTurn`).
    if (!provisional && task.sessionId === null) setSessionContext(db, task.id, startedContext(handoff, sandboxed))
    // The session's calls are decided against the live session, which exists once the backend has started it.
    let decide: (call: ToolPermissionCall) => Promise<ToolPermissionAnswer> = () => Promise.resolve(WITHDRAWN)
    let verdict: (prompt: string) => PromptVerdict = () => PromptVerdict.Allow
    let jobsListed: (jobs: readonly SessionJob[]) => void = () => undefined
    let compacted: (compaction: CompactSummary) => void = () => undefined
    let bashFinished: (call: BashCallFinished) => Promise<BashFinishedAnswer> = () => Promise.resolve(NOTHING_TO_ADD)
    let accessRequested: (call: AccessCallStarting) => void = () => undefined
    // A call that starts before the session is live is refused: there's nothing yet to decide it against.
    let starting: (call: ToolCallStarting) => Promise<ToolStartDecision | null> = () => Promise.resolve(WITHDRAWN)
    // A hook that fires before the session is live leaves its call, or its turn's end, as it is.
    let childCall: (call: ChildCallStarting) => Promise<ToolInput | null> = () => Promise.resolve(null)
    let batchDone: (batch: ToolBatch) => Promise<string | null> = () => Promise.resolve(null)
    let ending: (ending: TurnEnding) => Promise<string | null> = () => Promise.resolve(null)
    // Settled once a sandboxed session has its overlay, or wouldn't take it.
    let overlaid: (taken: boolean) => void = () => undefined
    const overlay = new Promise<boolean>((resolve) => {
      overlaid = resolve
    })
    const started = backend.start({
      taskId: task.id,
      createMcpServers: () => mcpServers(getTask(db, task.id) ?? task),
      onSubagentEvent: (event) => {
        try {
          onEvent(task.id, live, event)
        } catch (error) {
          taskLog(task.id).error('failed to handle a child event', { kind: event.kind, error })
        }
      },
      ...(provisional ? { provisional: true } : {}),
      cwd: workspace.rootPath,
      model: task.model,
      effort: task.effort,
      permissionMode: task.permissionMode,
      resumeSessionId: task.sessionId,
      systemPromptAppend: systemPromptAppend(task, settings, control, handoff, sandboxed),
      mcpServers: servers,
      env: sessionEnv(task),
      allowedRules,
      ...(sandboxed ? { flagSettings: sandboxStartSettings(workspace.rootPath, home, denied) } : {}),
      // Nothing can be filed under a todo without an id: the session keeps the tools that give todos one.
      keepTaskTools: true,
      log: agentLog(task.id),
      onToolPermission: (call) => decide(call),
      hooks: {
        onBashStarting: (call) => changes.bashStarting(task.id, call),
        onPrompt: (prompt) => verdict(prompt),
        onTurnEnded: (jobs) => {
          jobsListed(jobs)
        },
        onCompacted: (compaction) => {
          compacted(compaction)
        },
        // A sandboxed session's commands tell the runner how they went before the agent reads their results, so a
        // sandbox that couldn't start is known before the agent can ask to run outside it.
        ...(sandboxed ? { onBashFinished: (call: BashCallFinished) => bashFinished(call) } : {}),
        // And each `request_access` call says which it is, and whose, for the card it may open.
        ...(sandboxed
          ? {
              onAccessRequested: (call: AccessCallStarting) => {
                accessRequested(call)
              },
              // And each call to a tool the sandbox bounds is checked against the bounds before it runs, whatever
              // rule of Claude Code's would let it through.
              onToolStarting: (call: ToolCallStarting) => starting(call),
            }
          : {}),
        // What the agent's own calls make is filed under its todos as it's made.
        onChildStarting: (call: ChildCallStarting) => childCall(call),
        onBatchFinished: (batch: ToolBatch) => batchDone(batch),
        onTurnEnding: (turnEnd: TurnEnding) => ending(turnEnd),
      },
    })
    // The commands the user's Claude Code settings keep out of the sandbox, read as they're first needed.
    const excluded = createExcludedCommands({
      files: sandboxed ? (options.claudeSettings?.(workspace.rootPath) ?? []) : [],
      log: agentLog(task.id),
    })
    // The servers the session was given in-process: Glade's own, whose tools need no grant.
    const inProcess = [...Object.keys(servers), AGENTS_SERVER]
    // A sandboxed session's messages and settings wait on its overlay: whether its commands ask is in the overlay
    // alone, so nothing reaches the agent before it, or at all if the session won't take it.
    const session = sandboxed ? gatedSession(started, overlay) : started
    const live: LiveSession = {
      session,
      owner: { id: task.id, workspaceId: task.workspaceId },
      turn: null,
      settings: { model: task.model, effort: task.effort, permissionMode: task.permissionMode },
      sandbox: sandboxed
        ? {
            root: workspace.rootPath,
            ...checkedGrants(task.id, workspace.rootPath, grantsOf(task), excluded, inProcess),
            held: null,
            writeRules: new Set(writeRules.map(({ toolName }) => toolName)),
            failure: null,
            excluded,
            asking: new Map(),
            started: new Map(),
          }
        : null,
      rules: null,
      gladeServers: [...gladeOwnServers(servers), AGENTS_SERVER],
      inProcess,
      reported: new Map(),
      control,
      requests: new Map(),
      accessCalls: [],
      sdkModel: null,
      modelChanged: false,
      limit: null,
      closed: false,
      subagents: new Map(),
      background: new Map(),
      backgroundCalls: new Map(),
      woken: new Map(),
      unknownWakes: new Map(),
      callParents: new Map(),
      handed: [],
      compactSummary: null,
    }
    decide = (call) => decideToolCall(task.id, live, call)
    verdict = (prompt) => promptVerdict(task.id, live, prompt)
    jobsListed = (jobs) => {
      if (!live.closed) watchers.jobsListed(task.id, jobs)
    }
    compacted = ({ trigger, summary }) => {
      if (live.closed) return
      agentLog(task.id).info('compaction summary', { trigger, length: summary.length })
      live.compactSummary = carriedOver(summary)
    }
    bashFinished = (call) => {
      onBashFinished(task.id, live, call)
      return Promise.resolve(NOTHING_TO_ADD)
    }
    accessRequested = (call) => {
      live.accessCalls.push(call)
      live.accessCalls.splice(0, Math.max(0, live.accessCalls.length - MAX_HANDED))
    }
    starting = (call) => toolStarting(task.id, live, call)
    childCall = (call) => childStarting(task.id, live, call)
    batchDone = (batch) => batchFinished(task.id, live, batch)
    ending = (turnEnd) => turnEnding(task.id, live, turnEnd)
    // A provisional session's sandbox failure leaves the original task and pause intact.
    if (sandboxed) {
      if (provisional && live.sandbox !== null) {
        void live.session
          .applyFlagSettings(
            sandboxOverlay(live.sandbox.root, live.settings.permissionMode, live.sandbox.grants, home, denied),
          )
          .then(
            () => {
              overlaid(true)
            },
            () => {
              overlaid(false)
            },
          )
      } else void applySandbox(task.id, live).then(overlaid)
    }
    if (!provisional) activate(task, live)
    return live
  }

  /** What's granted to a task now (`AgentRunnerOptions.sandboxGrants`). */
  const grantsOf = (task: Task): SandboxGrants => options.sandboxGrants?.(task) ?? NO_GRANTS

  /**
   * A task's grants as its session's sandbox holds them: the ones the sandbox can take, and the bounds they make with
   * the root, resolved once here so deciding a call resolves only the call's own path. A grant the sandbox can't take
   * (`usableGrants`) is logged and left out, of the overlay and the bounds alike.
   */
  const checkedGrants = (
    taskId: string,
    root: string,
    granted: SandboxGrants,
    excluded: ExcludedCommands,
    inProcess: readonly string[],
  ): Pick<LiveSandbox, 'grants' | 'bounds'> => {
    const { grants, rejected } = usableGrants(granted)
    for (const { value, problem } of rejected) {
      agentLog(taskId).warn('left a grant out of the sandbox', { value, problem })
    }
    const unsandboxed = (command: string): boolean => excluded.matches(command)
    // One of the task's own subagents: exactly the id the SDK gave an `Agent` call of this task's. Nothing looser.
    const ownSubagent = (target: string): boolean => findSubagentCall(db, taskId, target) !== undefined
    return { grants, bounds: sandboxBounds({ root, home, grants, denied, unsandboxed, inProcess, ownSubagent }) }
  }

  /**
   * Gives a sandboxed session the overlay for its permission mode and grants (`sandboxOverlay`): straight after start,
   * before its first message, and whenever its mode changes. Answers whether it took it. One the SDK refuses, or that
   * can't be applied at all, closes the session (`onSandboxNotApplied`): it's never left running without it. The
   * session is asked at once, in order with what's asked of it before and after, but the answer is only acted on later,
   * even when applying throws, so a session that has just started has its turn by then.
   */
  const applySandbox = async (taskId: string, live: LiveSession): Promise<boolean> => {
    const { sandbox } = live
    if (sandbox === null) return true
    const overlay = sandboxOverlay(sandbox.root, live.settings.permissionMode, sandbox.grants, home, denied)
    let applied: Promise<void>
    try {
      applied = live.session.applyFlagSettings(overlay)
    } catch (error) {
      applied = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    try {
      await applied
      return true
    } catch (error) {
      onSandboxNotApplied(taskId, live, error)
      return false
    }
  }

  /**
   * A sandboxed session's `Bash` call has run: one that failed because the sandbox couldn't start (Claude Code's
   * `Sandbox is required but failed to initialize`, `docs/sdk-notes.md` §15) marks the session's sandbox failed, so
   * every request to run outside it from then on is refused, and the turn it's in ends on the error. One that failed
   * saying the sandbox blocked it is marked so. Any other call, whatever it printed, changes nothing.
   */
  const onBashFinished = (taskId: string, live: LiveSession, call: BashCallFinished): void => {
    const { sandbox } = live
    if (sandbox === null || live.closed) return
    if (!call.failed) return
    // A command the sandbox blocked fails saying so: which path, it doesn't reliably say. One that ran outside the
    // sandbox wasn't blocked by it, whatever it says.
    const blocked = BLOCKED_BY_SANDBOX.test(call.output)
    if (blocked && !isSandboxOverride(getToolCall(db, taskId, call.toolUseId)?.input ?? {})) {
      mark(taskId, call.toolUseId, { kind: PermissionMarkKind.Blocked, ask: null })
    }
    const reason = sandboxFailureReason(call.output)
    if (reason === null) return
    const failure = call.output.trim()
    if (sandbox.failure === null) {
      taskLog(taskId).error("the sandbox couldn't start", { reason, toolUseId: call.toolUseId })
      sandbox.failure = failure
    }
    const { turn } = live
    if (turn === null) {
      stopOnError(taskId, sandboxError(failure))
      return
    }
    turn.sandboxFailure ??= failure
  }

  /** Asks a session that just started which account it runs on, for Settings › General (`AgentRunnerOptions.account`). */
  const readAccount = (taskId: string, live: LiveSession): void => {
    const { account } = options
    if (account === undefined || agentSource(live.settings.model) === AgentSource.OpenRouter) return
    live.session.accountInfo().then(
      (info) => {
        if (!live.closed) account.accountRead(info)
      },
      (error: unknown) => {
        agentLog(taskId).warn("couldn't read the account", { error })
      },
    )
  }

  /**
   * Asks a session how much of the account's usage limits is used, for the sidebar's usage meter
   * (`AgentRunnerOptions.account`): as it starts, and after each turn. The call is experimental: when it fails, the
   * meter goes on with what the rate limit events say.
   */
  const readUsage = (taskId: string, live: LiveSession): void => {
    const { account } = options
    if (account === undefined || agentSource(live.settings.model) === AgentSource.OpenRouter) return
    live.session.usage().then(
      (usage) => {
        if (!live.closed) account.usageRead(usage)
      },
      (error: unknown) => {
        agentLog(taskId).info("couldn't read usage: going on with the rate limit events", {
          error: describeError(error),
        })
      },
    )
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
      give(live, RESUME_PROMPT, uuid)
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
      if (settings.model !== model) {
        // The next turn's init names the new model.
        live.sdkModel = null
        live.modelChanged = true
      }
      live.settings = { model, effort, permissionMode }
      const changed = live.session.configure(live.settings)
      if (changed === undefined) {
        if (settings.model !== model) recordSwitch(task.id, model)
      } else
        void changed.then(
          () => {
            if (!live.closed && settings.model !== model) recordSwitch(task.id, model)
          },
          () => {
            live.settings = settings
            if (getTask(db, task.id)?.model === model)
              updateTaskFromUser(context, task.id, { model: settings.model, effort: settings.effort })
            if (!live.closed && settings.model !== model)
              emitToolEventAppended(
                emit,
                appendNarration(db, {
                  taskId: task.id,
                  turn: Math.max(1, lastTurn(db, task.id)),
                  text: `Could not switch model to ${modelName(listModels(db), model)}. Continuing with ${modelName(listModels(db), settings.model)}.`,
                }),
              )
          },
        )
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
    const { queued, messages, dividers, block } = db.transaction(() => {
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
          : [
              appendMessage(db, {
                taskId,
                role: MessageRole.User,
                body: sent.text,
                turn,
                images: sent.images,
                pastedBlocks: sent.pastedBlocks,
                files: sent.files,
                broadcast: sent.broadcast,
              }),
            ]),
      ]
      const reopened = reopening ? [appendDivider(db, { taskId, turn, dividerKind: DividerKind.Reopened })] : []
      const divider = appendDivider(db, { taskId, turn, dividerKind: DividerKind.Turn })
      // Working in the same write as the turn's messages: if the app dies before the session gets them, the next
      // launch finds the turn working and carries it on (see `resume`), rather than a message nobody answers.
      startWorking(taskId, { db, emit: (event) => workingEvents.push(event) })
      // What the session is missing goes ahead of the turn's first message, once: it's recorded as given with it.
      const handoff = getHandoff(db, taskId) ?? null
      const check: ContextCheck = {
        recorded: getSessionContext(db, taskId),
        startedElsewhere: task.importedAt !== null,
        handoff,
        prompt: systemPromptAppend(task, getSettings(db), live.control, handoff, live.sandbox !== null),
        // A session that started before the sandbox was on, and resumed in it, is told of it once (#452).
        sandboxed: live.sandbox !== null,
      }
      const missing = messages.length === 0 ? [] : missingContext(check)
      if (missing.length > 0) setSessionContext(db, taskId, contextAfter(check, missing))
      const block = contextBlock(missing)
      return { queued, messages, dividers: [...markedDone, ...reopened, divider], block }
    })()
    for (const event of reopenEvents) emit(event)
    if (queued.length > 0) emitQueueChanged(emit, taskId, [])
    for (const message of messages) emitMessageAppended(emit, message)
    for (const divider of dividers) emitToolEventAppended(emit, divider)
    for (const event of workingEvents) emit(event)
    taskLog(taskId).info('turn started', { turn, messages: messages.length, queued: queued.length, reopening })

    live.turn = newTurn(turn)
    for (const [index, message] of messages.entries()) {
      live.turn.awaiting.add(message.id)
      hand(live, message, message.id, index === 0 ? block : null)
    }
    if (block !== null) taskLog(taskId).info('session context sent', { turn })
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
    // An allowed call may be made again, once; a folder or domain needs no such pass, since its grant is in force.
    const allowed = (request: PermissionRequest): boolean =>
      request.state === PermissionRequestState.Allowed && request.grantedScope === null
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
    give(live, permissionsDecidedAfterRestart(pending), uuid)
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
    give(live, answeredAfterRestart(reply), uuid)
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
    async changeModel(taskId, model) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      validateModel(db, model)
      if (task.model === model) return task
      if (switching.has(taskId)) throw new CommandFailure(BridgeErrorCode.Busy, 'The task is switching models')
      const crossesRouter =
        agentSource(task.model) === AgentSource.OpenRouter || agentSource(model) === AgentSource.OpenRouter
      if (!crossesRouter) return updateTaskFromUser(context, taskId, { model })
      const destinationWindow = taskModelWindow(db, model)
      if (task.contextUsedTokens > destinationWindow)
        throw new CommandFailure(
          BridgeErrorCode.InvalidRequest,
          `This task uses about ${String(task.contextUsedTokens)} tokens. The selected model holds ${String(destinationWindow)}. Choose a model with a larger context window, or compact this task before switching.`,
        )
      const limited = task.pause?.reason === PauseReason.UsageLimit
      const previous = sessions.get(taskId)
      if (
        previous?.turn != null ||
        task.activity === TaskActivity.Working ||
        task.asking ||
        task.awaitingPermission ||
        (!limited &&
          (task.backgroundWork || listWatchers(db, taskId).some(({ state }) => LIVE_WATCHER_STATES.includes(state))))
      ) {
        throw new CommandFailure(
          BridgeErrorCode.Busy,
          'Finish or stop the task and its background work before switching models.',
        )
      }
      if (task.sessionId === null) {
        if (previous !== undefined) restartSession(taskId, 'model changed before the session initialized')
        return updateTaskFromUser(context, taskId, { model })
      }
      switching.add(taskId)
      let candidate: LiveSession | undefined
      let adopted = false
      try {
        const effort = effortWithModel(db, model, undefined, task.effort) ?? task.effort
        candidate = start({ ...task, model, effort }, true)
        preparing.set(taskId, candidate)
        await waitForModelSwitch(candidate.session.ready?.() ?? Promise.resolve())
        if (candidate.closed)
          throw new CommandFailure(BridgeErrorCode.Busy, 'The task closed while its new session started.')
        if (getTask(db, taskId)?.model !== task.model)
          throw new CommandFailure(BridgeErrorCode.Busy, 'The task changed while its new session started.')
        const current = getTask(db, taskId)
        if (
          previous?.turn != null ||
          current?.activity === TaskActivity.Working ||
          current?.asking ||
          current?.awaitingPermission ||
          (!(limited && current?.pause?.reason === PauseReason.UsageLimit) &&
            (current?.backgroundWork ||
              listWatchers(db, taskId).some(({ state }) => LIVE_WATCHER_STATES.includes(state))))
        )
          throw new CommandFailure(BridgeErrorCode.Busy, 'The agent started work while its new session started.')
        const changed = db.transaction(() => {
          const changed = updateTaskFromUser(context, taskId, { model, effort })
          candidate?.session.activate?.()
          return changed
        })()
        adopted = true
        // Install the committed destination before post-commit notifications can fail.
        activate(changed, candidate)
        if (previous !== undefined) {
          if (limited) sessionGone(taskId, previous, 'Background work ended when the paused task switched models.')
          previous.closed = true
          previous.session.close()
        }
        filer.sessionEnded(taskId)
        watchers.sessionEnded(taskId, 'Model changed.')
        changes.sessionEnded(taskId)
        recordSwitch(taskId, model)
        switching.delete(taskId)
        if (changed.pause?.reason === PauseReason.UsageLimit && agentSource(model) === AgentSource.OpenRouter)
          runner.retry(taskId)
        else if (changed.activity === TaskActivity.Waiting) startQueued(taskId, candidate)
        return getTask(db, taskId) ?? changed
      } catch (error) {
        if (candidate !== undefined && !adopted) {
          candidate.closed = true
          candidate.session.close()
        }
        throw error
      } finally {
        preparing.delete(taskId)
        switching.delete(taskId)
        if (deferredPauses.delete(taskId)) onPauseDue(taskId)
      }
    },
    send(taskId, text, images = [], pastedBlocks = [], files = [], broadcast = false) {
      if (switching.has(taskId)) throw new CommandFailure(BridgeErrorCode.Busy, 'The task is switching models')
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      // The agent waits on answers to its questions: the message answers them, rather than starting a turn.
      const open = getOpenQuestionSet(db, taskId)
      if (open !== undefined) {
        // A broadcast went to every task, so it's no answer to this one's questions: it waits for them in the queue.
        if (broadcast) {
          throw new CommandFailure(
            BridgeErrorCode.Busy,
            'The agent is waiting on your answers; queue the message instead',
          )
        }
        if (images.length > 0 || pastedBlocks.length > 0 || files.length > 0) {
          throw new CommandFailure(
            BridgeErrorCode.InvalidRequest,
            'An answer to the agent’s questions can’t have images, files or pasted text',
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
      const sent = { text, images, pastedBlocks, files, broadcast }
      const message = startTurn(task, sessions.get(taskId) ?? start(task), sent).at(-1)
      if (message === undefined) throw new Error(`The turn for task ${taskId} started without its message`)
      return message
    },

    answer(id, answers, anythingElse) {
      const set = getQuestionSet(db, id)
      if (set === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No question set ${id}`)
      if (set.state !== QuestionSetState.Open) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'The questions are not open any more')
      }
      const checked = checkAnswers(set.questions, answers)
      if (!checked.ok) throw new CommandFailure(BridgeErrorCode.InvalidRequest, checked.problems.join('; '))
      const other = tidyAnythingElse(anythingElse)
      return replyTo(answerable(set), set, {
        kind: QuestionReplyKind.Answers,
        answers: checked.answers,
        ...(other === undefined ? {} : { anythingElse: other }),
      })
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
      const idle = sessions.get(request.taskId)
      // The answer may have granted the task a rule.
      if (idle !== undefined) idle.rules = null
      // No call waits on it to apply what it granted: the other running sessions the grant covers get it now, and the
      // session resumed to tell the agent starts with it.
      const task = getTask(db, request.taskId)
      if (answered.grantedScope !== null && task !== undefined) {
        void runner.applySandboxGrants(cardGrantTarget(answered.grantedScope, task))
      }
      deliverAfterRestart(request.taskId)
      return answered
    },

    async requestAccess(taskId, request, call) {
      const live = sessions.get(taskId)
      if (live === undefined || live.closed) return { kind: AccessOutcomeKind.Withdrawn }
      const { sandbox } = live
      if (sandbox === null) return { kind: AccessOutcomeKind.SandboxOff }
      const caller = accessCaller(live, request, call.toolUseId)
      const plan = accessPlan(request, sandbox.bounds)
      taskLog(taskId).info('access requested', { ...caller, access: request.access, plan: plan.kind })
      const access = request.access === FileAccess.Read ? FolderAccess.Read : FolderAccess.ReadWrite
      /** What the call asked for, as the path it named: for a mark on a call that opened no card. */
      const named: SandboxFolderAsk = {
        kind: SandboxAskKind.Folder,
        path: absolutePath(request.path, sandbox.bounds.root, sandbox.bounds.home),
        access,
      }
      // The command the sandbox blocked just before, the same agent's, is the one this asks about: its mark now says
      // what of.
      const blocked = blockedJustBefore(taskId, caller.toolUseId)
      if (blocked !== null) {
        const ask = plan.kind === AccessPlanKind.Ask ? plan.ask : named
        mark(taskId, blocked, { kind: PermissionMarkKind.Blocked, ask })
      }
      switch (plan.kind) {
        case AccessPlanKind.InWorkspace:
          return { kind: AccessOutcomeKind.InWorkspace }
        case AccessPlanKind.Credential:
          mark(taskId, caller.toolUseId, { kind: PermissionMarkKind.Blocked, ask: named })
          return { kind: AccessOutcomeKind.Credential }
        case AccessPlanKind.NotGrantable:
          return { kind: AccessOutcomeKind.NotGrantable, problem: plan.problem }
        case AccessPlanKind.TooBroad:
          return { kind: AccessOutcomeKind.TooBroad }
        case AccessPlanKind.Protected:
          mark(taskId, caller.toolUseId, { kind: PermissionMarkKind.Blocked, ask: named })
          return { kind: AccessOutcomeKind.Protected }
        case AccessPlanKind.AlreadyAllowed: {
          const use = { kind: SandboxGrantKind.Folder, key: plan.key, access } as const
          const granting = grantingGrant(heldBy(live, sandbox), use)
          if (granting?.grant.kind === SandboxGrantKind.Folder) {
            const ask = grantedAsk(granting.grant, access)
            mark(taskId, caller.toolUseId, { kind: PermissionMarkKind.Grant, scope: granting.scope, ask })
          }
          return { kind: AccessOutcomeKind.AlreadyAllowed, scope: granting?.scope ?? null }
        }
        case AccessPlanKind.Ask:
          break
      }
      const { ask } = plan
      const denied = deniedEarlier(taskId, turnOf(taskId, live, caller.toolUseId), ask)
      if (denied !== undefined) {
        taskLog(taskId).info('access denied as earlier in the turn', { ...caller, requestId: denied.id })
        return { kind: AccessOutcomeKind.Denied, note: denied.denyNote, earlier: true }
      }
      const { request: opened, decision } = await requested(
        taskId,
        live,
        {
          ...caller,
          toolName: ACCESS_TOOL_NAME,
          input: { path: request.path, access: request.access, reason: request.reason },
          title: null,
          displayName: null,
          description: request.reason,
          suggestions: [],
          defaultToNo: false,
          suppressAlwaysAllowRule: true,
          sandbox: ask,
        },
        call.signal,
      )
      if (decision === null) return { kind: AccessOutcomeKind.Withdrawn }
      const scope = grantedScope(decision, opened)
      if (!(await applyGrant(taskId, live, scope))) return { kind: AccessOutcomeKind.Withdrawn }
      carryOn(taskId, live)
      if (scope !== null) return { kind: AccessOutcomeKind.Allowed, folder: ask.path, access: ask.access, scope }
      const note = decision.kind === PermissionDecisionKind.Deny ? (decision.note?.trim() ?? '') : ''
      return { kind: AccessOutcomeKind.Denied, note: note === '' ? null : note }
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
      void Promise.resolve(live.session.configure(live.settings)).catch(() => undefined)
      // Whether sandboxed commands ask goes with the mode. The overlay carries the session's grants as it does.
      void applySandbox(taskId, live)
    },

    async applySandboxGrants(target, { awaitTaskId } = {}) {
      const awaited: Promise<SandboxApplied>[] = []
      const pending: string[] = []
      for (const [taskId, live] of sessions) {
        const task = getTask(db, taskId)
        const { sandbox } = live
        if (task === undefined || sandbox === null || live.closed || !grantCovers(target, task)) continue
        // The session's calls are decided against the new grants at once, and its commands once the overlay lands.
        const { grants, bounds } = checkedGrants(taskId, sandbox.root, grantsOf(task), sandbox.excluded, live.inProcess)
        sandbox.grants = grants
        sandbox.bounds = bounds
        sandbox.held = null
        agentLog(taskId).info('sandbox grants changed', {
          folders: grants.folders.length,
          domains: grants.domains.length,
          servers: bounds.servers.length,
          agents: bounds.agents.length,
        })
        const applying = applySandbox(taskId, live)
        // A session nobody waits on applies in the background: applying never rejects.
        if (awaitTaskId !== undefined && awaitTaskId !== taskId) pending.push(taskId)
        else awaited.push(applying.then((applied) => ({ taskId, applied })))
      }
      const answered = await Promise.all(awaited)
      return {
        applied: answered.filter(({ applied }) => applied).map(({ taskId }) => taskId),
        closed: answered.filter(({ applied }) => !applied).map(({ taskId }) => taskId),
        pending,
      }
    },

    queue(taskId, text, images = [], pastedBlocks = [], files = [], broadcast = false) {
      const task = getTask(db, taskId)
      if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const queued = addQueuedMessage(context, { taskId, body: text, images, pastedBlocks, files, broadcast })
      // A paused task delivers its queue once it resumes, and one waiting on requests the app quit on once you decide.
      if (switching.has(taskId) || isPaused(task) || waitsOnRestartRequests(taskId)) return queued
      // So does one waiting on a question the app quit on (only a broadcast is queued then, #489): its answer carries
      // on the turn that asked, and the queue follows.
      if (getOpenQuestionSet(db, taskId) !== undefined) return queued
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
      if (live === undefined || turn === null) {
        // No turn to stop: messages queued behind the requests just withdrawn, or left by an earlier Stop, go now.
        if (holdsQueue(taskId)) startQueued(taskId, live)
        return getTask(db, taskId) ?? task
      }
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

    async stopWatcher(taskId, id) {
      if (getTask(db, taskId) === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      const watcher = getWatcher(db, id)
      if (watcher?.taskId !== taskId) throw new CommandFailure(BridgeErrorCode.NotFound, `No watcher ${id}`)
      const live = sessions.get(taskId)
      const isTask = watcher.kind === WatcherKind.Monitor || watcher.kind === WatcherKind.Command
      if (isTask && live === undefined) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, "The watcher's session isn't running")
      }
      const request = watchers.requestStop(taskId, id)
      if (request === undefined) throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'The watcher has ended')
      taskLog(taskId).info('watcher stop requested', { watcherId: id, kind: watcher.kind })
      switch (request.action) {
        case StopAction.StopTask:
          await live?.session.stopTask(request.sdkTaskId)
          return
        case StopAction.None:
          return
      }
    },

    retry(taskId, model) {
      if (switching.has(taskId)) throw new CommandFailure(BridgeErrorCode.Busy, 'The task is switching models')
      if (model !== undefined) {
        const before = getTask(db, taskId)
        if (
          before !== undefined &&
          before.model !== model &&
          (agentSource(before.model) === AgentSource.OpenRouter || agentSource(model) === AgentSource.OpenRouter)
        ) {
          throw new CommandFailure(BridgeErrorCode.InvalidRequest, 'Select the new model before retrying the task.')
        }
      }
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
      if (task.error?.kind === AgentErrorKind.LoggedOut) restartSession(taskId, 'restarting for a new login')
      // A sandbox only starts with its session: retrying in a new one gives it another go (`docs/sdk-notes.md` §15).
      if (task.error?.source === TaskErrorSource.Sandbox) {
        restartSession(taskId, "restarting the sandbox that couldn't start", SANDBOX_RESTARTED_NOTE)
      }
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

    resumePaused(taskId) {
      onPauseDue(taskId)
    },

    refreshUsage() {
      const asked = [...sessions].find(
        ([, live]) => !live.closed && agentSource(live.settings.model) === AgentSource.Anthropic,
      )
      if (asked === undefined) return false
      readUsage(...asked)
      return true
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
      live.turn.compactOnly = true
      const uuid = randomUUID()
      live.turn.awaiting.add(uuid)
      give(live, COMPACT_COMMAND, uuid)
      return getTask(db, taskId) ?? task
    },

    resumeInterrupted() {
      // Every session died with the app: its watchers' processes and wakeups with it, and its cron jobs until it resumes.
      watchers.relaunched()
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
          stopOnError(task.id, withRetries(task.id, null, failure))
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
      // A queue nothing will deliver (its turn was stopped, before #441 sent it): it starts the task's next turn.
      for (const taskId of listTasksWithQueuedMessages(db)) {
        if (!holdsQueue(taskId)) continue
        try {
          if (startQueued(taskId, undefined)) taskLog(taskId).info('queue left by a stopped turn sent on launch')
        } catch (error) {
          taskLog(taskId).error('failed to send the queue left by a stopped turn', { error })
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
      filer.sessionEnded(taskId)
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
      for (const live of preparing.values()) {
        live.closed = true
        live.session.close()
      }
      preparing.clear()
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
