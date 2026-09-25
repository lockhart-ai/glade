/**
 * How a permission request (`PermissionRequest` in `./domain`) is put in a line: the tool, and the command or file it
 * acts on. Its notification says it, and the permission card can too. And the rule Allow for this task grants for a
 * request, and how Claude Code writes a rule.
 */
import {
  PermissionRuleBehavior,
  PermissionUpdateType,
  type PermissionRequest,
  type PermissionRule,
  type ToolInput,
} from './domain'
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

/** The tool whose calls are only ever granted a command prefix, never the whole tool. */
const BASH = 'Bash'

/** A `Bash` rule's content that covers every command. */
const EVERY_COMMAND = /^\s*:?\s*\*\s*$/

/**
 * The rule Allow for this task grants for a request (`docs/decisions.md`, "Per-call permission review"), or null when
 * it isn't offered. The rule is the one the SDK suggests adding for the call (Claude Code's own choice of command
 * prefix, e.g. `Bash` with `npm test *`), whatever settings file it suggests saving it in, since Glade keeps it per
 * task instead. With no rule suggested, it's the whole tool, e.g. `Edit`, except for `Bash`, which is never granted
 * whole, not even by a rule whose content is a wildcard alone. It isn't offered when the SDK says the request mustn't be remembered (`suppressAlwaysAllowRule`), or when the
 * SDK suggests anything but exactly one rule for the tool (a compound command gets one per command it runs): the card
 * names what it grants, and never grants more or less than that.
 */
export function taskPermissionRule(
  request: Pick<PermissionRequest, 'toolName' | 'suggestions' | 'suppressAlwaysAllowRule'>,
): PermissionRule | null {
  const { toolName, suggestions, suppressAlwaysAllowRule } = request
  if (suppressAlwaysAllowRule) return null
  const rules = suggestions.flatMap((suggestion) =>
    suggestion.type === PermissionUpdateType.AddRules && suggestion.behavior === PermissionRuleBehavior.Allow
      ? suggestion.rules
      : [],
  )
  const [rule, ...others] = rules
  const content = rule?.ruleContent ?? ''
  if (rule === undefined || (rule.toolName === toolName && content.trim() === '' && others.length === 0)) {
    return toolName === BASH ? null : { toolName }
  }
  if (others.length > 0 || rule.toolName !== toolName) return null
  // A wildcard alone (`*`, `:*`) would cover every command: as good as the whole of Bash.
  if (toolName === BASH && EVERY_COMMAND.test(content)) return null
  return { toolName, ruleContent: content }
}

/**
 * A rule as Claude Code writes it in `allowedTools` and settings files: `Edit` for the whole tool, or `Bash(npm test *)`
 * with its content, whose backslashes and parentheses are escaped with a backslash.
 */
export function permissionRuleString(rule: PermissionRule): string {
  const content = rule.ruleContent ?? ''
  if (content === '') return rule.toolName
  return `${rule.toolName}(${content.replace(/[\\()]/g, (character) => `\\${character}`)})`
}
