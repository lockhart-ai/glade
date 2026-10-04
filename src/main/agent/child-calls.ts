/**
 * The calls of Claude Code's own tools that make something a todo can hold (a "child": a subagent, a watcher, a
 * scheduled wakeup or cron job, a commit), in the shapes the P16-01 probes recorded (`docs/sdk-notes.md` §16), for the
 * scripted agent's scripts to build (`./scripts`). Since the phase split into Agents and Todos, Glade reads a todo off
 * two of them alone (P16-04, #495; `readsTodo`): an `Agent` call, whose subagent works on that todo, and a `Bash` call
 * in the foreground, whose commits go under it. A watcher isn't filed, so a `Monitor`, background `Bash`,
 * `ScheduleWakeup` or `CronCreate` call is left exactly as the model wrote it, whatever its text starts with.
 *
 * - Glade can't add a field to these tools, so a todo's id travels as a marker at the start of the call's own free
 *   text: `[todo 2] Review the date helpers`. Which text depends on the tool (`TODO_FIELDS`).
 * - A `PreToolUse` hook sees the whole input and can hand the tool a changed one (`updatedInput`), so the marker never
 *   reaches what the SDK says of the call afterwards (its task's description, a job's prompt). The `tool_use` block the
 *   model wrote keeps it.
 * - A call such a hook refuses comes back as an error result, `hookRefusal`, and the tool never runs.
 */
import type { ToolInput } from '../../shared/domain'

/** The tools of Claude Code's own that make a child. `Bash` does when it runs in the background, or commits. */
export enum ChildTool {
  Agent = 'Agent',
  Monitor = 'Monitor',
  Bash = 'Bash',
  ScheduleWakeup = 'ScheduleWakeup',
  CronCreate = 'CronCreate',
}

/** The free text of each tool's input that a todo's marker goes at the start of. */
export const TODO_FIELDS: Readonly<Record<ChildTool, string>> = {
  [ChildTool.Agent]: 'description',
  [ChildTool.Monitor]: 'description',
  [ChildTool.Bash]: 'description',
  [ChildTool.ScheduleWakeup]: 'reason',
  [ChildTool.CronCreate]: 'prompt',
}

const CHILD_TOOLS: readonly string[] = Object.values(ChildTool)

/** Whether a tool, by name, is one that makes a child. */
export function isChildTool(name: string): name is ChildTool {
  return CHILD_TOOLS.includes(name)
}

/** How a call names its todo: `[todo 2]`, with the id Claude Code gave the todo (`Task #2`). */
export function todoMarker(todoId: string): string {
  return `[todo ${todoId}]`
}

/**
 * The marker at the start of a text. The models wrote `[todo 2]` every time in the probes; a `#` before the id, other
 * case and space around it are read too.
 */
const MARKER = /^\s*\[todo #?(\d+)\]\s*/i

/** A call's input with its todo named: the marker at the start of the tool's free text. */
export function nameTodo(tool: ChildTool, input: ToolInput, todoId: string): ToolInput {
  const field = TODO_FIELDS[tool]
  const text = input[field]
  return {
    ...input,
    [field]: typeof text === 'string' && text !== '' ? `${todoMarker(todoId)} ${text}` : todoMarker(todoId),
  }
}

/** The todo a call names, and the call's input without the marker. */
export interface NamedTodo {
  readonly todoId: string
  readonly input: ToolInput
}

/**
 * The todo a call names, with the input the tool should run with (the marker taken off); null for a tool that makes
 * no child, and for a call that names none.
 */
export function namedTodo(tool: string, input: ToolInput): NamedTodo | null {
  if (!isChildTool(tool)) return null
  const field = TODO_FIELDS[tool]
  const text = input[field]
  if (typeof text !== 'string') return null
  const marked = MARKER.exec(text)
  if (marked === null) return null
  const [marker, todoId = ''] = marked
  return { todoId, input: { ...input, [field]: text.slice(marker.length) } }
}

/** A call as `readsTodo` takes it: the tool, its input, and whether a subagent made it. */
export interface TodoCall {
  readonly toolName: string
  readonly input: ToolInput
  /** Whether one of the task's subagents made the call, not its own agent. */
  readonly subagent: boolean
}

/**
 * Whether Glade reads the todo a call names (P16-04, #495):
 *
 * - an `Agent` call, whoever makes it: the subagent it starts works on that todo. A subagent's own `Agent` call is
 *   read too, since a subagent's subagent works on its parent's todo unless it names another;
 * - the agent's own `Bash` call in the foreground: what it commits goes under that todo. A subagent's commits follow
 *   its todo, so its `Bash` calls aren't read.
 *
 * Nothing else: a watcher's call (`Monitor`, `Bash` with `run_in_background`, `ScheduleWakeup`, `CronCreate`) is left
 * exactly as it is.
 */
export function readsTodo({ toolName, input, subagent }: TodoCall): boolean {
  if (!isChildTool(toolName)) return false
  switch (toolName) {
    case ChildTool.Agent:
      return true
    case ChildTool.Bash:
      return !subagent && input.run_in_background !== true
    case ChildTool.Monitor:
    case ChildTool.ScheduleWakeup:
    case ChildTool.CronCreate:
      return false
  }
}

/** The tools `readsTodo` reads a todo off, as the SDK names them: what a hook matches. */
export const TODO_TOOLS: readonly ChildTool[] = [ChildTool.Agent, ChildTool.Bash]

/** What the agent reads as the result of a call a `PreToolUse` hook refused, with the hook's reason. */
export function hookRefusal(tool: string, reason: string): string {
  return `PreToolUse:${tool} hook error: ${reason}`
}
