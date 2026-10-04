/**
 * The calls of Claude Code's own tools that Glade reads a todo off (P16-04, #495; `readsTodo`), in the shapes the
 * P16-01 probes recorded (`docs/sdk-notes.md` §16): an `Agent` call, whose subagent works on that todo, and a `Bash`
 * call in the foreground, whose commits go under it. Nothing else: a watcher isn't filed, so a `Monitor`, background
 * `Bash`, `ScheduleWakeup` or `CronCreate` call is left exactly as the model wrote it, whatever its text starts with,
 * and nothing here knows those tools (#535).
 *
 * - Glade can't add a field to these tools, so a todo's id travels as a marker at the start of the call's own free
 *   text, its description (`TODO_FIELD`): `[todo 2] Review the date helpers`.
 * - A `PreToolUse` hook sees the whole input and can hand the tool a changed one (`updatedInput`), so the marker never
 *   reaches what the SDK says of the call afterwards (its task's description). The `tool_use` block the model wrote
 *   keeps it.
 * - A call such a hook refuses comes back as an error result, `hookRefusal`, and the tool never runs.
 */
import type { ToolInput } from '../../shared/domain'

/** The tools of Claude Code's own a todo is read off: `Agent`, and `Bash`, which may commit. */
export enum ChildTool {
  Agent = 'Agent',
  Bash = 'Bash',
}

/** The free text of a call's input that a todo's marker goes at the start of: either tool's description. */
export const TODO_FIELD = 'description'

/** The tools a todo is read off, as the SDK names them: what a hook matches. */
export const TODO_TOOLS: readonly ChildTool[] = Object.values(ChildTool)

const CHILD_TOOLS: readonly string[] = TODO_TOOLS

/** Whether a tool, by name, is one a todo is read off. */
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

/** An `Agent` or `Bash` call's input with its todo named: the marker at the start of its description. */
export function nameTodo(input: ToolInput, todoId: string): ToolInput {
  const text = input[TODO_FIELD]
  return {
    ...input,
    [TODO_FIELD]: typeof text === 'string' && text !== '' ? `${todoMarker(todoId)} ${text}` : todoMarker(todoId),
  }
}

/** The todo a call names, and the call's input without the marker. */
export interface NamedTodo {
  readonly todoId: string
  readonly input: ToolInput
}

/**
 * The todo a call names, with the input the tool should run with (the marker taken off); null for a tool no todo is
 * read off, and for a call that names none.
 */
export function namedTodo(tool: string, input: ToolInput): NamedTodo | null {
  if (!isChildTool(tool)) return null
  const text = input[TODO_FIELD]
  if (typeof text !== 'string') return null
  const marked = MARKER.exec(text)
  if (marked === null) return null
  const [marker, todoId = ''] = marked
  return { todoId, input: { ...input, [TODO_FIELD]: text.slice(marker.length) } }
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
  }
}

/** What the agent reads as the result of a call a `PreToolUse` hook refused, with the hook's reason. */
export function hookRefusal(tool: string, reason: string): string {
  return `PreToolUse:${tool} hook error: ${reason}`
}
