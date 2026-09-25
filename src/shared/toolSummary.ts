/**
 * The one-line argument the tool log shows after a tool call's name (`Read src/app.ts`, `Bash npm test`), shared by the
 * window's tool log and the control API's chat (`get_chat`, `docs/control-api.md`), so both say the same.
 */
import type { ToolCallEvent, ToolInput } from './domain'

/** How long the short JSON of an MCP tool's input may be before it's cut; the row's ellipsis shows the rest. */
const MAX_JSON_SUMMARY = 200

/** Tools whose argument is the file they work on, and the input field that names it. */
const FILE_FIELDS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** Tools whose argument is one input field other than a file. */
const ARGUMENT_FIELDS: Readonly<Record<string, string>> = {
  Grep: 'pattern',
  Glob: 'pattern',
  Bash: 'command',
  WebFetch: 'url',
  WebSearch: 'query',
  Agent: 'description',
  Task: 'description',
}

/** An input field's value, when it's a string. */
export function stringField(input: ToolInput, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' ? value : undefined
}

/** The first line of a text, trimmed; empty when it has none. */
export function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim()
}

/** A path relative to the workspace root when it's inside it, as the tool log shows it; otherwise as given. */
export function relativePath(path: string, rootPath: string | undefined): string {
  if (rootPath === undefined) return path
  const root = rootPath.endsWith('/') ? rootPath : `${rootPath}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** A tool input as compact JSON, cut short when long. */
function shortJson(input: ToolInput): string {
  const json = JSON.stringify(input)
  return json.length > MAX_JSON_SUMMARY ? `${json.slice(0, MAX_JSON_SUMMARY)}…` : json
}

/**
 * The one-line argument after a tool call's name: the file for Read, Write and Edit (relative to the workspace root),
 * the pattern for Grep, the command for Bash, and so on. An MCP tool's is its input as short JSON; any other tool's is
 * its first string input, or its input as short JSON when it has none.
 */
export function argumentSummary(call: Pick<ToolCallEvent, 'name' | 'input'>, rootPath?: string): string {
  const { name, input } = call
  if (name.startsWith('mcp__')) return Object.keys(input).length === 0 ? '' : shortJson(input)

  const fileField = FILE_FIELDS[name]
  const file = fileField === undefined ? undefined : stringField(input, fileField)
  if (file !== undefined) return relativePath(file, rootPath)

  const field = ARGUMENT_FIELDS[name]
  const argument = field === undefined ? undefined : stringField(input, field)
  if (argument !== undefined) return firstLine(argument)

  const firstString = Object.values(input).find((value): value is string => typeof value === 'string')
  if (firstString !== undefined) return firstLine(firstString)
  return Object.keys(input).length === 0 ? '' : shortJson(input)
}
