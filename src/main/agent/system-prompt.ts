/**
 * What Glade appends to Claude Code's system prompt for a task's session: which task this is, how to keep its title,
 * objective and status current with the Glade tools (`./glade-tools`), and when to ask the user with `ask`. Anything about files on disk comes from
 * the workspace's CLAUDE.md, not from here (`docs/model-surface.md`).
 */
import type { Task, TaskHandoff } from '../../shared/domain'
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
 * follows in the Watchers tab (`docs/sdk-notes.md` §13), and not to background them in a shell, which nothing tracks.
 */
export const WATCHERS_LINE =
  'When you leave a script running to watch something (a PR, CI, a deploy, a remote job), start it with the Monitor ' +
  "tool or with Bash's run_in_background, not by backgrounding it yourself (nohup, &), so it shows in the task's " +
  'Watchers tab.'

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
 * The prompt for `task`'s session. With `upkeep` turned off in Settings, it leaves out asking for a title or a status,
 * as the session's Glade tools leave out the tools for them. With `control`, the session has the `glade-control`
 * tools, and the prompt says so in one line. With a `handoff`, the prompt ends with it (`handoffSection`).
 */
export function systemPromptAppend(
  task: Task,
  upkeep: AgentUpkeep = ALL_UPKEEP,
  control = false,
  handoff: TaskHandoff | null = null,
): string {
  const named = task.title !== ''
  const lines = [
    'You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.',
    'This session is one Glade task, with one objective.',
    `Its task id is ${task.id}. Its title is ${named ? `"${task.title}"` : 'not set yet'}.`,
    '',
    'The user sees the task through its title, objective and status. Keep them current with the Glade tools:',
  ]
  // Only what isn't set yet: a title the user chose, or an objective already recorded, stays as it is.
  const unset = [
    ...(named || !upkeep.taskTitles ? [] : [`${GladeTool.SetTitle} with a short name for the task`]),
    ...(task.objective === '' ? [`${GladeTool.SetObjective} with its objective`] : []),
  ]
  if (unset.length > 0) {
    lines.push(
      `- After the user's first message, before anything else, even for a quick question, call ${unset.join(' and ')}.`,
    )
  }
  if (upkeep.statusSummary) {
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
      'with its path and a short title, so it shows in the Artifacts tab and stays with the task after it is done.',
    '',
    WATCHERS_LINE,
  )
  if (control) lines.push('', CONTROL_TOOLS_LINE)
  if (handoff !== null) lines.push('', handoffSection(handoff))
  return lines.join('\n')
}
