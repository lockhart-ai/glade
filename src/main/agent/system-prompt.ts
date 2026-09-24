/**
 * What Glade appends to Claude Code's system prompt for a task's session: which task this is, and how to keep its
 * title, objective and status current with the Glade tools (`./glade-tools`). Anything about files on disk comes from
 * the workspace's CLAUDE.md, not from here (`docs/model-surface.md`).
 */
import type { Task } from '../../shared/domain'
import { GladeTool } from './glade-tools'

export function systemPromptAppend(task: Task): string {
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
    ...(named ? [] : [`${GladeTool.SetTitle} with a short name for the task`]),
    ...(task.objective === '' ? [`${GladeTool.SetObjective} with its objective`] : []),
  ]
  if (unset.length > 0) {
    lines.push(
      `- After the user's first message, before anything else, even for a quick question, call ${unset.join(' and ')}.`,
    )
  }
  lines.push(
    `- Every turn, call ${GladeTool.SetStatus} with one line on where the work stands, and again before you end ` +
      'the turn if that changed. When the task is done, the status is its outcome.',
  )
  return lines.join('\n')
}
