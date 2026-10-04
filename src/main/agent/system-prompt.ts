/**
 * What Glade appends to Claude Code's system prompt for a task's session: which task this is, that the user sees only
 * its final reply each turn, how to keep its title, objective and status current with the Glade tools
 * (`./glade-tools`), and when to ask the user with `ask`. Anything about files on disk comes from
 * the workspace's CLAUDE.md, not from here (`docs/model-surface.md`).
 */
import type { Task, TaskHandoff } from '../../shared/domain'
import { FILE_CHILDREN_TOOL } from '../../shared/toolName'
import { CONTROL_SERVER } from '../control/names'
import { ALL_UPKEEP, GladeTool, type AgentUpkeep } from './glade-tools'

/**
 * What the prompt says of the `glade-control` tools (`docs/control-api.md`), when the session has them: that they
 * exist, behind tool search, and are for when the user asks.
 */
export const CONTROL_TOOLS_LINE =
  `This session also has Glade's control tools (the ${CONTROL_SERVER} MCP server; find them with tool search): ` +
  "they list, read, create, change, message and delete Glade's tasks. Use them only when the user asks you to work " +
  'with Glade or its other tasks.'

/**
 * What the prompt says of long-lived watch scripts: to run them with the SDK's own background tools, which Glade
 * follows as watchers in the Agents tab (`docs/sdk-notes.md` §13), and not to background them in a shell, which
 * nothing tracks.
 */
export const WATCHERS_LINE =
  'When you leave a script running to watch something (a PR, CI, a deploy, a remote job), start it with the Monitor ' +
  "tool or with Bash's run_in_background, not by backgrounding it yourself (nohup, &), so it shows in the task's " +
  'Agents tab.'

/**
 * What the prompt says of the agent's replies (#301): the chat shows only the final one of each turn, and the rest goes
 * to the tool log (`docs/product.md`, the chat log), so that one must answer the user on its own.
 */
export const FINAL_REPLY_LINE =
  'In the chat, the user sees only your last message of each turn: what you write before a tool call goes to the ' +
  'tool log, which they rarely read. So end every turn with a complete reply that answers what they asked or responds ' +
  'to what they said, with any findings, even ones you wrote earlier in the turn. Do follow-up work (tool calls) ' +
  'before that reply, not after it.'

/**
 * What the prompt says of link artifacts (#407): the PRs the agent opens or works on, and the issues or tickets the task
 * is about, are artifacts too, by URL, so they aren't scattered through the chat and the tool log.
 */
export const LINK_ARTIFACTS_LINE =
  `When you open or work on a pull request, or the task is about an issue or a ticket (GitHub, Jira), call ` +
  `${GladeTool.AddArtifact} with its url and a short title, so the user finds it in the Todos tab next to the ` +
  'files.'

/**
 * What the prompt says of the agent sandbox, in a session that runs in one (#445, #450): what its commands can use,
 * and that a command the sandbox blocks is answered with `request_access`, not by leaving the sandbox. A session
 * resumed from before the sandbox was turned on keeps its old prompt (Claude Code applies the append at start only),
 * so it's sent this once, ahead of its next message, when it resumes in the sandbox (`./session-context`, #452). The
 * tool's own description says when to call it too.
 */
export const SANDBOX_LINE =
  'Your commands run in a sandbox: they can read and write the workspace folder, and beyond it only the folders ' +
  'and network domains the user has allowed. When a command fails with "Operation not permitted" on a path outside ' +
  `the workspace, don't retry it outside the sandbox: call ${GladeTool.RequestAccess} with the absolute path, ` +
  'whether you need to read or write it, and a short reason. It asks the user and waits; once it says the access is ' +
  'allowed, run the command again.'

/**
 * What the prompt says of the todo hub's tools (P16-05, #496): that they exist and what they're for, which is all a
 * task needs to sort what it made before the hub when asked to ("file your things under your todos").
 */
export const TODO_HUB_TOOLS_LINE =
  'What this task has produced (its artifacts and commits) shows to the user under its todos. ' +
  `${GladeTool.ListChildren} lists them, each with a short id and the todo it's under, and ${GladeTool.FileChildren} ` +
  'files them under a todo or moves them to another, by those ids. When the user asks you to file or sort what you ' +
  'made, list them, then file them all in one call.'

/**
 * What the prompt says of filing what the agent produces as it's made (P16-04, #495): to name the todo in the `Agent` call that starts a subagent and in the `Bash` call that commits, and what Glade
 * does when a call names none. The wording is the one #492 probed (`docs/sdk-notes.md` §16), with the filing tool's
 * real name, cut down to those two calls when the phase split into Agents and Todos: it asks for no marker on a
 * watcher's call (`Monitor`, background `Bash`, `ScheduleWakeup`, `CronCreate`), which Glade leaves as it is.
 */
export const TODO_HUB_FILING_LINE =
  'Glade files every commit you make under one of your todos, where the user finds it, and each subagent you start ' +
  'works on one of them. Name the todo in the call: start the description of an Agent call, and of a Bash call that ' +
  'commits, with the todo\'s id in square brackets, like "[todo 2] Review the date helpers". Create the todo first ' +
  '(TaskCreate) if none fits. If a call names none, Glade asks you right after it to file what it made, with ' +
  `${FILE_CHILDREN_TOOL}: do that at once, before your next step. What a subagent commits goes under its todo by ` +
  'itself: leave those.'

/** What the prompt says of an artifact's todo: `add_artifact` needs one. */
export const TODO_HUB_ARTIFACTS_LINE = `An artifact goes under a todo too: give ${GladeTool.AddArtifact} the todo's id as todo, for a file and for a link.`

/**
 * Everything the prompt says of the todo hub, a paragraph each. They aren't in `INSTRUCTION_UPDATES`: the hub was built
 * behind a switch, so whether a session has them is tracked by itself, as the sandbox's line is. A session that started
 * without them (before the hub, or while it was behind its switch) is sent them once, ahead of its next message
 * (`./session-context`).
 */
export const TODO_HUB_LINES: readonly string[] = [TODO_HUB_FILING_LINE, TODO_HUB_ARTIFACTS_LINE, TODO_HUB_TOOLS_LINE]

/**
 * The instructions added to the prompt after sessions had started with it, oldest first. Claude Code keeps a session's
 * prompt when it resumes it, so a session that started before one was added is sent it once, ahead of its next message
 * (`./session-context`). Only ever append: a session's place in this list is saved as a count. `SANDBOX_LINE` (for
 * sandboxed sessions alone) and `TODO_HUB_LINES` (some sessions had them before every session did) aren't here: each is
 * tracked by itself.
 */
export const INSTRUCTION_UPDATES: readonly string[] = [FINAL_REPLY_LINE, LINK_ARTIFACTS_LINE]

/** The heading the handoff note goes under in the prompt. */
export const HANDOFF_HEADING = 'Handoff for this task (backfilled from earlier notes)'

/**
 * What the prompt says of a task's handoff note (`docs/control-api.md`, "Backfilling past tasks"): the note itself,
 * under a short heading, and that the paths it names are real. It's in the prompt, not the chat, so it survives
 * compaction.
 */
export function handoffSection(handoff: TaskHandoff): string {
  return [
    `## ${HANDOFF_HEADING}`,
    '',
    'This task was worked on before it was in Glade. This note says what it was, where it got to, the decisions ' +
      "made, what's next, and where its notes, artifacts and history are. Pick up from here. The paths it names are " +
      'real: read them when you need more than the note says.',
    '',
    handoff.body,
  ].join('\n')
}

/**
 * The prompt for `task`'s session. With upkeep turned off in `settings`, it leaves out asking for a title or a status,
 * as the session's Glade tools leave out the tools for them. It says how what the session makes is filed under its
 * todos and that it has the hub's tools (`TODO_HUB_LINES`). With `control`, the session has the `glade-control` tools,
 * and the prompt says so in one line. With a `handoff`, the prompt ends with it (`handoffSection`). In a
 * `sandboxed` session it says what the sandbox is and to ask with `request_access` (`SANDBOX_LINE`); with the sandbox
 * off it doesn't mention it.
 */
export function systemPromptAppend(
  task: Task,
  settings: AgentUpkeep = ALL_UPKEEP,
  control = false,
  handoff: TaskHandoff | null = null,
  sandboxed = false,
): string {
  const named = task.title !== ''
  const lines = [
    'You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.',
    'This session is one Glade task, with one objective.',
    `Its task id is ${task.id}. Its title is ${named ? `"${task.title}"` : 'not set yet'}.`,
    '',
    FINAL_REPLY_LINE,
    '',
    'The user sees the task through its title, objective and status. Keep them current with the Glade tools:',
  ]
  // Only what isn't set yet: a title the user chose, or an objective already recorded, stays as it is.
  const unset = [
    ...(named || !settings.taskTitles ? [] : [`${GladeTool.SetTitle} with a short name for the task`]),
    ...(task.objective === '' ? [`${GladeTool.SetObjective} with its objective`] : []),
  ]
  if (unset.length > 0) {
    lines.push(
      `- After the user's first message, before anything else, even for a quick question, call ${unset.join(' and ')}.`,
    )
  }
  if (settings.statusSummary) {
    lines.push(
      `- Every turn, call ${GladeTool.SetStatus} with one line on where the work stands, and again before you end ` +
        'the turn if that changed. When the task is done, the status is its outcome.',
    )
  }
  lines.push(
    '',
    `When you need the user to decide something before you can go on, call ${GladeTool.Ask} instead of asking in ` +
      'your reply: it shows your questions on a card and waits for the answers. Ask everything you need at once, ' +
      'with choices or pills when the likely answers are known. When you ask in response to a message, first respond ' +
      'to it in preamble, then ask.',
    '',
    `When you make a deliverable the user asked for (a report, a document, a draft), call ${GladeTool.AddArtifact} ` +
      'with its path and a short title, so it shows in the Todos tab and stays with the task after it is done. ' +
      `Keep that list current: if its file moves or it needs a new title, call ${GladeTool.UpdateArtifact}; if it's no ` +
      `longer a deliverable, call ${GladeTool.RemoveArtifact}.`,
    LINK_ARTIFACTS_LINE,
    '',
    WATCHERS_LINE,
  )
  lines.push(...TODO_HUB_LINES.flatMap((line) => ['', line]))
  if (sandboxed) lines.push('', SANDBOX_LINE)
  if (control) lines.push('', CONTROL_TOOLS_LINE)
  if (handoff !== null) lines.push('', handoffSection(handoff))
  return lines.join('\n')
}
