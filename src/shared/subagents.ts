// Which tool calls start a subagent, and what a subagent is called, as the Agents tab, the task list's subagent
// count, the plugins and the todo hub see them.
import type { ToolCallEvent } from './domain'
import { DISPATCH_AGENT_TOOL } from './managed-agents'

/** The tools that start a subagent: `Agent` in `tool_use` (the init tools list calls it `Task`). */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task', DISPATCH_AGENT_TOOL]

/** Whether a call to the named tool starts a subagent. */
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.includes(name)
}

/** What a subagent is called when its call names neither a description nor a type. */
export const UNNAMED_SUBAGENT = 'Subagent'

/** What a subagent is called: the description its call gives it, else its type. */
export function subagentName({ input }: Pick<ToolCallEvent, 'input'>): string {
  for (const field of ['description', 'subagent_type']) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return UNNAMED_SUBAGENT
}
