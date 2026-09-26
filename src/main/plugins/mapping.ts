/**
 * How Glade's own records become what a plugin is told (`docs/plugin-api.md`, "Events"). Each function builds its
 * plugin shape field by field from what the schema allows, so nothing else of a task, tool call, question or permission
 * request can reach a plugin: no chat, no tool results, no file contents, and of a tool's input only the one field the
 * tool log shows for the tools listed here. Free text is cut to `MAX_PLUGIN_TEXT`.
 */
import { needsYou } from '../../shared/attention'
import {
  PermissionRequestState,
  QuestionSetState,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type NarrationEvent,
  type PermissionRequest,
  type QuestionSet,
  type Task,
  type ToolCallEvent,
  type ToolInput,
} from '../../shared/domain'
import { workspaceRelativePath } from '../../shared/files'
import {
  MAX_PLUGIN_TEXT,
  PluginPermissionOutcome,
  PluginQuestionOutcome,
  PluginSubagentState,
  PluginTaskActivity,
  PluginTaskState,
  PluginToolCallState,
  PluginWaitingOn,
  type PluginPermissionRequest,
  type PluginQuestion,
  type PluginSubagent,
  type PluginTask,
  type PluginToolCall,
} from '../../shared/plugin-api'
import { isSubagentTool } from '../../shared/subagents'
import { toolDisplayName } from '../../shared/toolName'

/** What a subagent is called when its call names neither a description nor a type, as the Subagents tab has it. */
export const UNNAMED_SUBAGENT = 'Subagent'

/** The tools whose argument is the file they work on, and the input field that names it. */
const FILE_FIELDS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * The tools whose summary is one other input field, as the tool log shows it. Any tool not here or in `FILE_FIELDS`
 * (MCP tools, Glade's own, the todo tools, …) gets no summary: its input could hold anything.
 */
const SUMMARY_FIELDS: Readonly<Record<string, string>> = {
  Grep: 'pattern',
  Glob: 'pattern',
  Bash: 'command',
  WebFetch: 'url',
  WebSearch: 'query',
  Agent: 'description',
  Task: 'description',
}

/**
 * A text cut to `MAX_PLUGIN_TEXT` UTF-16 code units (what the schema and a page's `length` count), never through the
 * middle of a character.
 */
export function cutText(text: string): string {
  if (text.length <= MAX_PLUGIN_TEXT) return text
  let cut = ''
  for (const character of text) {
    if (cut.length + character.length > MAX_PLUGIN_TEXT) break
    cut += character
  }
  return cut
}

/** The first line of a text that isn't blank, trimmed; empty when it has none. */
function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim()
}

function stringField(input: ToolInput, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' ? value : undefined
}

function activity(value: TaskActivity): PluginTaskActivity {
  switch (value) {
    case TaskActivity.Waiting:
      return PluginTaskActivity.Waiting
    case TaskActivity.Working:
      return PluginTaskActivity.Working
    case TaskActivity.Error:
      return PluginTaskActivity.Error
    case TaskActivity.Paused:
      return PluginTaskActivity.Paused
  }
}

/** What a task's turn waits on: its questions before a permission card, as the task list says it. */
function waitingOn(task: Task): PluginWaitingOn | null {
  if (task.asking) return PluginWaitingOn.Question
  if (task.awaitingPermission) return PluginWaitingOn.Permission
  return null
}

/** A task as a plugin sees it. */
export function pluginTask(task: Task, workspaceName: string): PluginTask {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    workspaceName: cutText(workspaceName),
    title: cutText(task.title),
    status: cutText(task.status),
    state: task.state === TaskState.Done ? PluginTaskState.Done : PluginTaskState.Active,
    activity: activity(task.activity),
    needsYou: needsYou(task),
    waitingOn: waitingOn(task),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    doneAt: task.doneAt,
  }
}

/**
 * What a tool call acts on, as the tool log shows it: the file for the file tools (relative to the workspace root when
 * it's inside it), the pattern, command, URL or query for the tools that have one, a subagent's description. Only its
 * first line, cut short; empty for every other tool.
 */
export function toolSummary(name: string, input: ToolInput, rootPath: string | undefined): string {
  const fileField = FILE_FIELDS[name]
  const file = fileField === undefined ? undefined : stringField(input, fileField)
  if (file !== undefined)
    return cutText(rootPath === undefined ? file : (workspaceRelativePath(file, rootPath) ?? file))
  const field = SUMMARY_FIELDS[name]
  const argument = field === undefined ? undefined : stringField(input, field)
  return argument === undefined ? '' : cutText(firstLine(argument))
}

function toolCallState(state: ToolCallState): PluginToolCallState {
  switch (state) {
    case ToolCallState.Running:
      return PluginToolCallState.Running
    case ToolCallState.Done:
      return PluginToolCallState.Done
    case ToolCallState.Error:
      return PluginToolCallState.Failed
    // A call a pause cut off doesn't carry on: its turn starts again when the task resumes.
    case ToolCallState.Paused:
    case ToolCallState.Interrupted:
      return PluginToolCallState.Interrupted
  }
}

/** A tool call as a plugin sees it. */
export function pluginToolCall(call: ToolCallEvent, rootPath: string | undefined): PluginToolCall {
  return {
    id: call.toolUseId,
    taskId: call.taskId,
    subagentId: call.parentToolUseId,
    tool: cutText(toolDisplayName(call.name)),
    summary: toolSummary(call.name, call.input, rootPath),
    state: toolCallState(call.state),
    startedAt: call.createdAt,
    endedAt: call.finishedAt,
  }
}

/** Whether a tool call starts a subagent. */
export function startsSubagent(call: ToolCallEvent): boolean {
  return isSubagentTool(call.name)
}

function subagentState(state: ToolCallState): PluginSubagentState {
  switch (state) {
    case ToolCallState.Running:
      return PluginSubagentState.Running
    case ToolCallState.Done:
      return PluginSubagentState.Done
    case ToolCallState.Error:
      return PluginSubagentState.Failed
    case ToolCallState.Paused:
    case ToolCallState.Interrupted:
      return PluginSubagentState.Stopped
  }
}

/** What a subagent is called: its call's description, else its type, as the Subagents tab has it. */
function subagentName(input: ToolInput): string {
  for (const field of ['description', 'subagent_type']) {
    const value = stringField(input, field)?.trim()
    if (value !== undefined && value !== '') return cutText(value)
  }
  return UNNAMED_SUBAGENT
}

/** The subagent an `Agent` call started, as a plugin sees it, with the last thing it said or did. */
export function pluginSubagent(call: ToolCallEvent, latest: string | null): PluginSubagent {
  return {
    id: call.toolUseId,
    taskId: call.taskId,
    name: subagentName(call.input),
    state: subagentState(call.state),
    latest,
    startedAt: call.createdAt,
    endedAt: call.finishedAt,
  }
}

/**
 * A row of a subagent's log as its latest line: a tool call's name and summary (`Bash npm test`), or what it said. Never
 * what a call returned, or what the subagent came to: that's a tool result.
 */
export function latestLine(event: ToolCallEvent | NarrationEvent, rootPath: string | undefined): string {
  switch (event.kind) {
    case ToolEventKind.ToolCall:
      return cutText(`${toolDisplayName(event.name)} ${toolSummary(event.name, event.input, rootPath)}`.trim())
    case ToolEventKind.Narration:
      return cutText(event.text.trim())
  }
}

/** A question set as a plugin sees it: each question's prompt, and none of its options or answers. */
export function pluginQuestion(set: QuestionSet): PluginQuestion {
  return {
    taskId: set.taskId,
    questionSetId: set.id,
    prompts: set.questions.map((question) => cutText(question.prompt)),
    openedAt: set.createdAt,
  }
}

/** How a question set closed; null while it's open. */
export function questionOutcome(state: QuestionSetState): PluginQuestionOutcome | null {
  switch (state) {
    case QuestionSetState.Open:
      return null
    case QuestionSetState.Answered:
      return PluginQuestionOutcome.Answered
    case QuestionSetState.Withdrawn:
      return PluginQuestionOutcome.Withdrawn
  }
}

/**
 * A permission request as a plugin sees it: the tool and what it acts on, as its tool call has them. Not the prompt
 * Claude Code wrote for it, nor its input or suggestions. `subagentId` is the subagent whose call it is.
 */
export function pluginPermissionRequest(
  request: PermissionRequest,
  subagentId: string | null,
  rootPath: string | undefined,
): PluginPermissionRequest {
  return {
    taskId: request.taskId,
    requestId: request.id,
    subagentId,
    tool: cutText(toolDisplayName(request.toolName)),
    summary: toolSummary(request.toolName, request.input, rootPath),
    openedAt: request.createdAt,
  }
}

/** How a permission request closed; null while it's open. */
export function permissionOutcome(state: PermissionRequestState): PluginPermissionOutcome | null {
  switch (state) {
    case PermissionRequestState.Open:
      return null
    case PermissionRequestState.Allowed:
      return PluginPermissionOutcome.Allowed
    case PermissionRequestState.Denied:
      return PluginPermissionOutcome.Denied
    case PermissionRequestState.Withdrawn:
      return PluginPermissionOutcome.Withdrawn
  }
}
