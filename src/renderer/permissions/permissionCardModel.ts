/**
 * What the permission card (`docs/design/html/23-permission-card.html`) works out from a permission request: what's
 * asked, the input shown for it (a command, a file's change or new content, or formatted JSON), trimmed to a readable
 * length with the rest behind "Show all", which subagent made the call, and what a closed card's one line says.
 */
import {
  PermissionRequestState,
  ToolEventKind,
  type PermissionRequest,
  type ToolCallEvent,
  type ToolEvent,
  type ToolInput,
} from '../../shared/domain'
import { toolDisplayName } from '../../shared/toolName'
import { subagentName } from '../subagents/subagentsModel'
import { relativePath } from '../tool-log/toolLogModel'

/** How many lines of a command, change or content the card shows until you ask for all of it. */
export const TRIMMED_LINES = 12
/** How many characters of them it shows until then, so one very long line can't fill the chat either. */
export const TRIMMED_CHARS = 1200

/** How a line of the card's input block reads. */
export enum InputLineKind {
  /** Plain: a command's, new content's or JSON's line, or a change's unchanged context. */
  Plain = 'plain',
  /** A line an edit takes out. */
  Removed = 'removed',
  /** A line an edit puts in. */
  Added = 'added',
  /** Between two edits of one `MultiEdit`. */
  Gap = 'gap',
}

export interface InputLine {
  readonly kind: InputLineKind
  readonly text: string
}

/** The kinds of input the card shows. */
export enum PermissionBodyKind {
  /** `Bash`: the command, and what it's for. */
  Command = 'command',
  /** `Edit` and `MultiEdit`: the file, and its change as removed and added lines. */
  FileChange = 'file_change',
  /** `Write`: the file, and its new content. */
  FileContent = 'file_content',
  /** Any other tool: its input as formatted JSON. */
  Json = 'json',
}

export interface CommandBody {
  readonly kind: PermissionBodyKind.Command
  readonly lines: readonly InputLine[]
  /** What the command is for, as the agent or Claude Code put it; null when neither did. */
  readonly description: string | null
}

export interface FileChangeBody {
  readonly kind: PermissionBodyKind.FileChange
  /** Relative to the workspace root when it's inside it. */
  readonly path: string
  readonly lines: readonly InputLine[]
}

export interface FileContentBody {
  readonly kind: PermissionBodyKind.FileContent
  /** Relative to the workspace root when it's inside it. */
  readonly path: string
  readonly lines: readonly InputLine[]
}

export interface JsonBody {
  readonly kind: PermissionBodyKind.Json
  readonly lines: readonly InputLine[]
}

/** What the card shows of a call's input. */
export type PermissionBody = CommandBody | FileChangeBody | FileContentBody | JsonBody

function stringField(input: ToolInput, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' ? value : undefined
}

/** A text trimmed, or null when there's nothing to it. */
function nonBlank(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

function textLines(text: string, kind: InputLineKind): InputLine[] {
  return text.split('\n').map((line) => ({ kind, text: line }))
}

/**
 * One edit's change: the lines it takes out, then the lines it puts in, between the lines they start and end with alike,
 * which show unmarked, as context.
 */
function changeLines(edit: ToolInput): InputLine[] | null {
  const oldString = stringField(edit, 'old_string')
  const newString = stringField(edit, 'new_string')
  if (oldString === undefined || newString === undefined) return null
  const removed = oldString === '' ? [] : oldString.split('\n')
  const added = newString === '' ? [] : newString.split('\n')
  let start = 0
  while (start < removed.length && start < added.length && removed[start] === added[start]) start += 1
  let end = 0
  while (
    end < removed.length - start &&
    end < added.length - start &&
    removed[removed.length - 1 - end] === added[added.length - 1 - end]
  ) {
    end += 1
  }
  const lines = (texts: readonly string[], kind: InputLineKind): InputLine[] => texts.map((text) => ({ kind, text }))
  return [
    ...lines(removed.slice(0, start), InputLineKind.Plain),
    ...lines(removed.slice(start, removed.length - end), InputLineKind.Removed),
    ...lines(added.slice(start, added.length - end), InputLineKind.Added),
    ...lines(removed.slice(removed.length - end), InputLineKind.Plain),
  ]
}

function isToolInput(value: unknown): value is ToolInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A `MultiEdit`'s edits, each one's change, with a gap between them; null when its input isn't a list of edits. */
function multiEditLines(input: ToolInput): InputLine[] | null {
  const edits = input.edits
  if (!Array.isArray(edits)) return null
  const lines: InputLine[] = []
  for (const [index, edit] of edits.entries()) {
    const change = isToolInput(edit) ? changeLines(edit) : null
    if (change === null) return null
    if (index > 0) lines.push({ kind: InputLineKind.Gap, text: '⋯' })
    lines.push(...change)
  }
  return lines
}

/** A tool input as formatted JSON, line by line. */
function jsonBody(input: ToolInput): JsonBody {
  return { kind: PermissionBodyKind.Json, lines: textLines(JSON.stringify(input, null, 2), InputLineKind.Plain) }
}

/**
 * What the card shows of a call's input: for `Bash` the command and its description; for `Edit` and `MultiEdit` the
 * file and its change; for `Write` the file and its new content; for anything else, or input these don't fit (a `Bash`
 * without a command), its input as formatted JSON. Paths are relative to the workspace root when they're inside it.
 */
export function permissionBody(
  request: Pick<PermissionRequest, 'toolName' | 'input' | 'description'>,
  rootPath?: string,
): PermissionBody {
  const { toolName, input } = request
  switch (toolName) {
    case 'Bash': {
      const command = stringField(input, 'command')
      if (command === undefined) break
      const description = nonBlank(stringField(input, 'description')) ?? nonBlank(request.description)
      return { kind: PermissionBodyKind.Command, lines: textLines(command, InputLineKind.Plain), description }
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = stringField(input, 'file_path')
      const lines = toolName === 'Edit' ? changeLines(input) : multiEditLines(input)
      if (path === undefined || lines === null) break
      return { kind: PermissionBodyKind.FileChange, path: relativePath(path, rootPath), lines }
    }
    case 'Write': {
      const path = stringField(input, 'file_path')
      const content = stringField(input, 'content')
      if (path === undefined || content === undefined) break
      const lines = textLines(content, InputLineKind.Plain)
      return { kind: PermissionBodyKind.FileContent, path: relativePath(path, rootPath), lines }
    }
  }
  return jsonBody(input)
}

/** The lines the card shows: all of them, or, trimmed, the first few, cut short of `TRIMMED_CHARS`. */
export interface ShownLines {
  readonly lines: readonly InputLine[]
  /** Whether some are left out (or cut short): the card then offers to show all of them. */
  readonly trimmed: boolean
}

/** The lines to show: with `all`, every one; otherwise the first `TRIMMED_LINES`, within `TRIMMED_CHARS`. */
export function shownLines(lines: readonly InputLine[], all: boolean): ShownLines {
  if (all) return { lines, trimmed: false }
  const shown: InputLine[] = []
  let chars = 0
  for (const line of lines.slice(0, TRIMMED_LINES)) {
    const room = TRIMMED_CHARS - chars
    if (line.text.length > room) {
      shown.push({ ...line, text: `${line.text.slice(0, Math.max(0, room))}…` })
      return { lines: shown, trimmed: true }
    }
    shown.push(line)
    chars += line.text.length
  }
  return { lines: shown, trimmed: lines.length > shown.length }
}

/** "Show all 14 lines". */
export function showAllLabel(lines: readonly InputLine[]): string {
  return `Show all ${String(lines.length)} line${lines.length === 1 ? '' : 's'}`
}

/** What the card says is asked: Claude Code's prompt sentence when it wrote one, else the tool's name. */
export function permissionTitle(request: Pick<PermissionRequest, 'title' | 'toolName'>): string {
  return nonBlank(request.title) ?? toolDisplayName(request.toolName)
}

function toolCall(toolEvents: readonly ToolEvent[], toolUseId: string): ToolCallEvent | undefined {
  return toolEvents.find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
}

/** Which subagent made a subagent's call, as its tab names it. */
export interface SubagentOrigin {
  /** Its name (`subagentName`), or null when the call it made hasn't reached the tool log to say. */
  readonly name: string | null
}

/**
 * Which subagent made the call, or null for the agent's own. The request carries the SDK's id for the subagent; the
 * call's tool log row names the `Agent` call that started it, whose description names it.
 */
export function subagentOrigin(
  request: Pick<PermissionRequest, 'agentId' | 'toolUseId'>,
  toolEvents: readonly ToolEvent[],
): SubagentOrigin | null {
  if (request.agentId === null) return null
  const parent = toolCall(toolEvents, request.toolUseId)?.parentToolUseId ?? null
  const agentCall = parent === null ? undefined : toolCall(toolEvents, parent)
  return { name: agentCall === undefined ? null : subagentName(agentCall) }
}

/** "subagent · Upgrade guide", or just "subagent" when it isn't known which. */
export function subagentLabel(origin: SubagentOrigin): string {
  return origin.name === null ? 'subagent' : `subagent · ${origin.name}`
}

/** The call in a line, e.g. `Bash: npm test` or `Edit: src/date.ts` (relative to the workspace root). */
export function callSummary(request: Pick<PermissionRequest, 'toolName' | 'input'>, rootPath?: string): string {
  const name = toolDisplayName(request.toolName)
  const body = permissionBody({ ...request, description: null }, rootPath)
  switch (body.kind) {
    case PermissionBodyKind.Command:
      return `${name}: ${body.lines
        .map(({ text }) => text)
        .join(' ')
        .trim()}`
    case PermissionBodyKind.FileChange:
    case PermissionBodyKind.FileContent:
      return `${name}: ${body.path}`
    case PermissionBodyKind.Json:
      return name
  }
}

/** What a closed card says happened: "allowed once", "denied", "denied: “the note”", "withdrawn"; null while open. */
export function closedOutcome(request: Pick<PermissionRequest, 'state' | 'denyNote'>): string | null {
  switch (request.state) {
    case PermissionRequestState.Open:
      return null
    case PermissionRequestState.Allowed:
      return 'allowed once'
    case PermissionRequestState.Denied: {
      const note = nonBlank(request.denyNote)
      return note === null ? 'denied' : `denied: “${note}”`
    }
    case PermissionRequestState.Withdrawn:
      return 'withdrawn'
  }
}
