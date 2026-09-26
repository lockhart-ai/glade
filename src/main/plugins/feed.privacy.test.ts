// What never reaches a plugin (`docs/plugin-api.md`, "Not sent"). Every kind of event main emits goes through the feed
// with a sentinel in every text field a plugin mustn't see (chat, tool input and output, question options and answers,
// permission prompts, files, todos, the terminal, settings), and in the snapshot's rows too; none may come out. The
// fields a plugin may see carry markers of their own, which must come out, so the test can't pass by sending nothing.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { appCommand, AppCommandId } from '../../shared/commands'
import {
  AgentErrorKind,
  CompactionTrigger,
  DividerKind,
  Effort,
  MessageRole,
  PauseReason,
  PermissionDestination,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  TodoState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  WatcherKind,
  WatcherState,
  type PermissionRequest,
  type Question,
  type QuestionSet,
  type Task,
  type ToolCallEvent,
  type ToolInput,
  type Workspace,
} from '../../shared/domain'
import { ImageMediaType } from '../../shared/images'
import type { PluginEvent } from '../../shared/plugin-api'
import { pluginEventSchema } from '../../shared/plugin-api-schema'
import { PluginStatus } from '../../shared/plugins'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { appendPermissionRequest } from '../db/repositories/permission-requests'
import { appendQuestionSet } from '../db/repositories/question-sets'
import { createTask, updateTask } from '../db/repositories/tasks'
import { appendNarration, appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { createWorkspace } from '../db/repositories/workspaces'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { createPluginFeed } from './feed'
import { databaseFeedSource } from './feed-source'

/** Text a plugin must never see. */
const secret = (field: string): string => `SECRET_${field}`
/** Text a plugin may see. */
const allowed = (field: string): string => `OK_${field}`

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

/** The tool calls a turn might make, each with secrets in every input field but the one the tool log shows. */
function toolInputs(root: string): readonly (readonly [string, ToolInput])[] {
  return [
    ['Bash', { command: allowed('command'), description: secret('bash_description'), timeout: 1000 }],
    ['Write', { file_path: `${root}/${allowed('write.ts')}`, content: secret('write_content') }],
    [
      'Edit',
      { file_path: `${root}/${allowed('edit.ts')}`, old_string: secret('old_string'), new_string: secret('new') },
    ],
    [
      'MultiEdit',
      {
        file_path: `${root}/${allowed('multi.ts')}`,
        edits: [{ old_string: secret('m_old'), new_string: secret('m') }],
      },
    ],
    ['Read', { file_path: `${root}/${allowed('read.ts')}`, offset: 1, limit: 20 }],
    ['NotebookEdit', { notebook_path: `${root}/${allowed('nb.ipynb')}`, new_source: secret('cell') }],
    ['Grep', { pattern: allowed('pattern'), path: secret('grep_path'), glob: secret('glob') }],
    ['Glob', { pattern: allowed('glob_pattern'), path: secret('glob_path') }],
    ['WebFetch', { url: allowed('url'), prompt: secret('fetch_prompt') }],
    ['WebSearch', { query: allowed('query'), allowed_domains: [secret('domain')] }],
    ['Agent', { description: allowed('agent'), prompt: secret('agent_prompt'), subagent_type: secret('type') }],
    ['Task', { subagent_type: allowed('task_type'), prompt: secret('task_prompt') }],
    ['TodoWrite', { todos: [{ content: secret('todo'), status: 'pending', activeForm: secret('active') }] }],
    ['mcp__glade__ask', { questions: [{ prompt: secret('ask_input') }] }],
    ['mcp__glade__set_status', { status: secret('set_status_input') }],
    ['mcp__glade__set_objective', { objective: secret('objective_input') }],
    ['mcp__github__create_issue', { title: secret('issue_title'), body: secret('issue_body') }],
    ['SomeFutureTool', { text: secret('future_input') }],
    ['Bash', { command: 42, description: secret('non_string_command') }],
  ]
}

const QUESTIONS: readonly Question[] = [
  {
    kind: QuestionKind.Choice,
    prompt: allowed('choice_prompt'),
    options: [
      { id: secret('option_id'), label: secret('label'), detail: secret('detail'), sketch: secret('sketch') },
      { id: secret('option_2'), label: secret('label_2') },
    ],
  },
  { kind: QuestionKind.Pills, prompt: allowed('pills_prompt'), options: [secret('pill'), secret('pill_2')] },
  { kind: QuestionKind.Text, prompt: allowed('text_prompt'), placeholder: secret('placeholder'), optional: true },
]

function permission(task: Task, toolUseId: string, agentId: string | null) {
  return {
    taskId: task.id,
    turn: 1,
    toolUseId,
    agentId,
    toolName: 'Bash',
    input: { command: allowed('permission_command'), description: secret('permission_input') },
    title: secret('permission_title'),
    displayName: secret('permission_display'),
    description: secret('permission_description'),
    suggestions: [
      {
        type: PermissionUpdateType.AddRules as const,
        rules: [{ toolName: 'Bash', ruleContent: secret('rule') }],
        behavior: PermissionRuleBehavior.Allow,
        destination: PermissionDestination.LocalSettings,
      },
    ],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
  }
}

/** A task with a secret in every field but its title and status, which a plugin sees. */
function secretTask(workspace: Workspace, now: number): Task {
  const task = createTask(
    database.db,
    {
      workspaceId: workspace.id,
      model: secret('model'),
      effort: Effort.High,
      title: allowed('title'),
      objective: secret('objective'),
      status: allowed('status'),
    },
    now,
  )
  return updateTask(
    database.db,
    task.id,
    {
      activity: TaskActivity.Error,
      sessionId: secret(`session_${String(now)}`),
      error: {
        kind: AgentErrorKind.Permanent,
        source: TaskErrorSource.Api,
        status: 400,
        code: secret('error_code'),
        details: secret('error_details'),
        retries: 0,
        retryingMs: 0,
      },
    },
    now,
  )
}

/** Writes a subagent's turn to a task's tool log: calls with secret inputs and outputs, and notes. */
function writeTurn(task: Task, root: string, prefix: string): ToolCallEvent[] {
  const calls: ToolCallEvent[] = []
  const agent = appendToolCall(database.db, {
    taskId: task.id,
    turn: 1,
    name: 'Agent',
    input: { description: allowed('snapshot_agent'), prompt: secret('snapshot_agent_prompt') },
    toolUseId: `${prefix}_agent`,
    parentToolUseId: null,
  })
  calls.push(agent)
  appendNarration(database.db, { taskId: task.id, turn: 1, text: allowed('note'), parentToolUseId: agent.toolUseId })
  for (const [index, [name, input]] of toolInputs(root).entries()) {
    const toolUseId = `${prefix}_${String(index)}`
    calls.push(
      appendToolCall(database.db, {
        taskId: task.id,
        turn: 1,
        name,
        input,
        toolUseId,
        parentToolUseId: agent.toolUseId,
      }),
    )
    const state = index % 2 === 0 ? ToolCallState.Done : ToolCallState.Error
    calls[calls.length - 1] = updateToolCall(database.db, {
      taskId: task.id,
      toolUseId,
      state,
      output: secret(`output_${name}`),
    })
  }
  return calls
}

it('sends a plugin nothing it may not see, from the snapshot or from any event main emits', () => {
  const root = `/${secret('root')}/acme-api`
  const workspace = createWorkspace(database.db, { name: allowed('workspace'), rootPath: root }, 1_000)
  const task = secretTask(workspace, 2_000)
  writeTurn(task, root, 'snap')
  appendQuestionSet(database.db, { taskId: task.id, turn: 1, questions: QUESTIONS })
  appendPermissionRequest(database.db, permission(task, 'snap_0', 'agent-1'))

  const feed = createPluginFeed({ source: databaseFeedSource(database.db), tasks: [task] })
  const sent: PluginEvent[] = []
  feed.subscribe((event) => {
    expect(pluginEventSchema.parse(event)).toEqual(event)
    sent.push(event)
  })

  // A second task, created as events arrive, doing the same, then every other kind of event with its secrets.
  const created = secretTask(workspace, 3_000)
  const calls = writeTurn(created, root, 'live')
  const questionSet: QuestionSet = {
    id: 'questions-1',
    taskId: created.id,
    turn: 1,
    questions: QUESTIONS,
    state: QuestionSetState.Open,
    reply: null,
    createdAt: 4_000,
    closedAt: null,
  }
  const request: PermissionRequest = {
    ...permission(created, 'live_agent', null),
    id: 'request-1',
    state: PermissionRequestState.Open,
    denyNote: null,
    grantedRule: null,
    createdAt: 4_000,
    closedAt: null,
  }
  const every: { readonly [Type in EventType]: readonly Extract<GladeEvent, { type: Type }>[] } = {
    [EventType.WorkspaceUpdated]: [{ type: EventType.WorkspaceUpdated, workspace }],
    [EventType.TaskUpdated]: [
      { type: EventType.TaskUpdated, task: created },
      {
        type: EventType.TaskUpdated,
        task: {
          ...created,
          activity: TaskActivity.Paused,
          retrying: { attempt: 1, maxRetries: 10, since: 1 },
          pause: {
            reason: PauseReason.UsageLimit,
            since: 1,
            resumesAt: 2,
            checks: 0,
            details: secret('pause_details'),
          },
        },
      },
      { type: EventType.TaskUpdated, task: { ...created, state: TaskState.Done, status: allowed('outcome') } },
    ],
    [EventType.ToolEventAppended]: [
      ...calls.map((call) => ({
        type: EventType.ToolEventAppended as const,
        toolEvent: { ...call, state: ToolCallState.Running, output: null },
      })),
      {
        type: EventType.ToolEventAppended,
        toolEvent: {
          kind: ToolEventKind.Narration,
          id: 'note-1',
          taskId: created.id,
          turn: 1,
          createdAt: 4_000,
          text: allowed('live_note'),
          parentToolUseId: null,
        },
      },
      {
        type: EventType.ToolEventAppended,
        toolEvent: {
          kind: ToolEventKind.Divider,
          id: 'divider-1',
          taskId: created.id,
          turn: 2,
          createdAt: 4_000,
          dividerKind: DividerKind.Turn,
        },
      },
      {
        type: EventType.ToolEventAppended,
        toolEvent: {
          kind: ToolEventKind.Compaction,
          id: 'compaction-1',
          taskId: created.id,
          turn: 2,
          createdAt: 4_000,
          trigger: CompactionTrigger.Manual,
          state: ToolCallState.Done,
          preTokens: 1,
          postTokens: 1,
          windowTokens: 1,
        },
      },
    ],
    [EventType.ToolEventUpdated]: calls.map((call) => ({ type: EventType.ToolEventUpdated as const, toolEvent: call })),
    [EventType.MessageAppended]: [
      {
        type: EventType.MessageAppended,
        message: {
          id: 'message-1',
          taskId: created.id,
          role: MessageRole.User,
          body: secret('user_message'),
          turn: 1,
          createdAt: 4_000,
          summary: null,
          images: [{ id: secret('image'), mediaType: ImageMediaType.Png }],
        },
      },
      {
        type: EventType.MessageAppended,
        message: {
          id: 'message-2',
          taskId: created.id,
          role: MessageRole.Agent,
          body: secret('final_reply'),
          turn: 1,
          createdAt: 4_000,
          summary: { durationMs: 1, filesChanged: 1, linesAdded: 1, linesRemoved: 1 },
          images: [],
        },
      },
    ],
    [EventType.QueueChanged]: [
      {
        type: EventType.QueueChanged,
        taskId: created.id,
        queuedMessages: [{ id: 'queued-1', taskId: created.id, body: secret('queued'), createdAt: 1, images: [] }],
      },
    ],
    [EventType.QuestionOpened]: [{ type: EventType.QuestionOpened, questionSet }],
    [EventType.QuestionAnswered]: [
      {
        type: EventType.QuestionAnswered,
        questionSet: {
          ...questionSet,
          state: QuestionSetState.Answered,
          reply: { kind: QuestionReplyKind.Answers, answers: { 0: secret('answer'), 1: [secret('answers')] } },
        },
      },
    ],
    [EventType.QuestionWithdrawn]: [
      {
        type: EventType.QuestionWithdrawn,
        questionSet: {
          ...questionSet,
          id: 'questions-2',
          state: QuestionSetState.Withdrawn,
          reply: { kind: QuestionReplyKind.FreeText, text: secret('free_text') },
        },
      },
    ],
    [EventType.PermissionOpened]: [{ type: EventType.PermissionOpened, permissionRequest: request }],
    [EventType.PermissionAnswered]: [
      {
        type: EventType.PermissionAnswered,
        permissionRequest: { ...request, state: PermissionRequestState.Denied, denyNote: secret('deny_note') },
      },
      {
        type: EventType.PermissionAnswered,
        permissionRequest: {
          ...request,
          id: 'request-3',
          state: PermissionRequestState.Allowed,
          grantedRule: { toolName: 'Bash', ruleContent: secret('granted_rule') },
        },
      },
    ],
    [EventType.PermissionWithdrawn]: [
      {
        type: EventType.PermissionWithdrawn,
        permissionRequest: { ...request, id: 'request-2', state: PermissionRequestState.Withdrawn },
      },
    ],
    [EventType.OpenFilesChanged]: [
      {
        type: EventType.OpenFilesChanged,
        openFiles: { taskId: created.id, paths: [secret('open_file')], activePath: secret('active_file') },
      },
    ],
    [EventType.FileShown]: [{ type: EventType.FileShown, taskId: created.id, path: secret('shown_file'), line: 3 }],
    [EventType.TodosChanged]: [
      {
        type: EventType.TodosChanged,
        taskId: created.id,
        todos: {
          items: [{ text: secret('todo_text'), state: TodoState.Doing, note: secret('todo_note') }],
          updatedAt: 1,
        },
      },
    ],
    [EventType.ArtifactsChanged]: [
      {
        type: EventType.ArtifactsChanged,
        taskId: created.id,
        artifacts: [
          { taskId: created.id, path: secret('artifact_path'), title: secret('artifact'), addedAt: 1, updatedAt: 1 },
        ],
      },
    ],
    [EventType.HandoffChanged]: [
      {
        type: EventType.HandoffChanged,
        taskId: created.id,
        handoff: { taskId: created.id, body: secret('handoff'), addedAt: 1 },
      },
      { type: EventType.HandoffChanged, taskId: created.id, handoff: null },
    ],
    [EventType.WatchersChanged]: [
      {
        type: EventType.WatchersChanged,
        taskId: created.id,
        watchers: [
          {
            id: 'watcher-1',
            taskId: created.id,
            kind: WatcherKind.Monitor,
            toolUseId: 'toolu_watch',
            parentToolUseId: null,
            label: secret('watcher_label'),
            detail: secret('watcher_command'),
            schedule: null,
            recurring: true,
            state: WatcherState.Running,
            wakes: 1,
            lastWokeAt: 1,
            lastOutput: secret('watcher_output'),
            nextDueAt: null,
            expiresAt: null,
            outcome: null,
            startedAt: 1,
            endedAt: null,
          },
        ],
      },
    ],
    [EventType.TaskOpenRequested]: [{ type: EventType.TaskOpenRequested, taskId: created.id }],
    [EventType.UiStateChanged]: [
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.RelaunchNotice, value: secret('ui_state') } },
    ],
    [EventType.MenuCommand]: [{ type: EventType.MenuCommand, command: appCommand(AppCommandId.NewTask) }],
    [EventType.SettingsChanged]: [
      { type: EventType.SettingsChanged, settings: { ...DEFAULT_SETTINGS, defaultModel: secret('settings_model') } },
    ],
    [EventType.PluginsChanged]: [
      {
        type: EventType.PluginsChanged,
        plugins: [{ status: PluginStatus.Invalid, folder: secret('plugin'), reason: secret('reason') }],
      },
    ],
    [EventType.PluginStatusChanged]: [{ type: EventType.PluginStatusChanged, id: 'nekomata', text: secret('status') }],
    [EventType.ControlChanged]: [
      {
        type: EventType.ControlChanged,
        status: {
          enabled: true,
          chosenPort: 45233,
          port: 45233,
          url: 'http://127.0.0.1:45233/mcp',
          token: secret('token'),
          error: null,
        },
      },
    ],
    [EventType.TerminalTabsChanged]: [
      {
        type: EventType.TerminalTabsChanged,
        tabs: [{ id: 'tab-1', name: secret('tab'), process: secret('process'), running: true, cwd: secret('cwd') }],
      },
    ],
    [EventType.TerminalOutput]: [{ type: EventType.TerminalOutput, tabId: 'tab-1', offset: 0, data: secret('output') }],
    [EventType.TerminalCleared]: [{ type: EventType.TerminalCleared, tabId: 'tab-1' }],
    [EventType.TaskDeleted]: [{ type: EventType.TaskDeleted, taskId: task.id }],
    [EventType.WorkspaceRemoved]: [{ type: EventType.WorkspaceRemoved, workspaceId: workspace.id }],
  }
  for (const events of Object.values(every)) for (const event of events) feed.observe(event)

  const json = JSON.stringify(sent)
  expect(json.match(/SECRET_\w+/g) ?? []).toEqual([])
  const seen = new Set(json.match(/OK_[\w.]+/g))
  expect([...seen].sort()).toEqual(
    [
      'workspace',
      'title',
      'status',
      'outcome',
      'live_note',
      'snapshot_agent',
      'command',
      'write.ts',
      'edit.ts',
      'multi.ts',
      'read.ts',
      'nb.ipynb',
      'pattern',
      'glob_pattern',
      'url',
      'query',
      'agent',
      'task_type',
      'choice_prompt',
      'pills_prompt',
      'text_prompt',
      'permission_command',
    ]
      .map(allowed)
      .sort(),
  )
  // Every kind of plugin event but hello (which the view sends) came out of this.
  expect(new Set(sent.map(({ type }) => type)).size).toBe(12)
})
