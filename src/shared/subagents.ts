// Which tool calls start a subagent, as the Subagents tab, the task list's subagent count and the plugins see them.

/** The tools that start a subagent: `Agent` in `tool_use` (the init tools list calls it `Task`). */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ['Agent', 'Task']

/** Whether a call to the named tool starts a subagent. */
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.includes(name)
}
