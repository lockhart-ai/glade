/**
 * How a permission request (`PermissionRequest` in `./domain`) is put in a line: the tool, and the command or file it
 * acts on. Its notification says it, and the permission card can too.
 */
import type { ToolInput } from './domain'
import { toolDisplayName } from './toolName'

/** The input field that says what each tool acts on: the command, or the file. */
const SUBJECT_FIELDS: Readonly<Record<string, string>> = {
  Bash: 'command',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  Read: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** What a tool call acts on: its command or file, or null when Glade doesn't know (or the input doesn't say). */
export function permissionSubject(toolName: string, input: ToolInput): string | null {
  const field = SUBJECT_FIELDS[toolName]
  const value = field === undefined ? undefined : input[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The tool call in a line, e.g. `Bash: npm test` or `Edit: src/date.ts`; just the tool when there's nothing more. */
export function permissionSummary(toolName: string, input: ToolInput): string {
  const name = toolDisplayName(toolName)
  const subject = permissionSubject(toolName, input)
  return subject === null ? name : `${name}: ${subject}`
}
