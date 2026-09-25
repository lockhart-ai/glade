/**
 * What a background task's wake says. The SDK wakes the agent for a `Monitor` event, or a background task ending, by
 * submitting a prompt of its own made of `<task-notification>` blocks, which only the session's `UserPromptSubmit` hook
 * sees: nothing in the message stream carries a monitor's events (`docs/sdk-notes.md` §13). An event:
 *
 *   <task-notification>
 *   <task-id>b03hdfcxm</task-id>
 *   <summary>Monitor event: "ticks"</summary>
 *   <event>tick 1</event>
 *   </task-notification>
 *
 * and an ending, which may carry the monitor's last event too:
 *
 *   <task-notification>
 *   <task-id>be9dsw3k8</task-id>
 *   <tool-use-id>toolu_01…</tool-use-id>
 *   <output-file>…/tasks/be9dsw3k8.output</output-file>
 *   <status>completed</status>
 *   <summary>Monitor "burst" stream ended</summary>
 *   <event>c</event>
 *   </task-notification>
 */

/** One `<task-notification>` block of a wake's prompt. */
export interface TaskNotice {
  /** The SDK's id for the task. */
  readonly taskId: string
  /** How it ended (`completed`, `failed`, `stopped`), for an ending; null for an event. */
  readonly status: string | null
  readonly summary: string | null
  /** The event's lines (several, when they came together), as printed; null for an ending without one. */
  readonly event: string | null
}

const BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g

/** The text of the first `<tag>…</tag>` in `block`; an event runs to its last closing tag, since it's free text. */
function tag(block: string, name: string): string | null {
  const open = `<${name}>`
  const start = block.indexOf(open)
  if (start < 0) return null
  const close = `</${name}>`
  const end = name === 'event' ? block.lastIndexOf(close) : block.indexOf(close, start)
  if (end < start) return null
  return block.slice(start + open.length, end)
}

/** Every task notification in a prompt, in order; none for a prompt that isn't a wake's (yours, or a job's). */
export function parseTaskNotices(prompt: string): TaskNotice[] {
  return [...prompt.matchAll(BLOCK)].flatMap(([, block = '']) => {
    const taskId = tag(block, 'task-id')?.trim() ?? ''
    if (taskId === '') return []
    return [
      {
        taskId,
        status: tag(block, 'status')?.trim() ?? null,
        summary: tag(block, 'summary'),
        event: tag(block, 'event'),
      },
    ]
  })
}

/** The last non-blank line of an event, which the Watchers tab shows as what the watch last reported. */
export function lastLine(text: string): string | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines.at(-1)?.trim() ?? null
}
