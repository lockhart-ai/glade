import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { appCommand, AppCommandId } from '../../shared/commands'
import {
  AgentErrorKind,
  CompactionTrigger,
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionMode,
  PermissionRequestState,
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type PermissionRequest,
  type QuestionSet,
  type Task,
  type ToolCallEvent,
} from '../../shared/domain'
import { ImageMediaType } from '../../shared/images'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createEventLog } from './event-log'
import { LogLevel, LogScope, type LogRecord } from './logger'
import { createMemoryLog, type MemoryLog } from './memory-sink'

let database: TestDatabase
let task: Task
let log: MemoryLog
let logEvent: (event: GladeEvent) => void

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  log = createMemoryLog()
  logEvent = createEventLog(log.logger, [task])
})

afterEach(() => {
  database.close()
})

/** Each record as its level, scope, message and fields, for comparing. */
function logged(): Pick<LogRecord, 'level' | 'scope' | 'message' | 'fields'>[] {
  return log.records.map(({ level, scope, message, fields }) => ({ level, scope, message, fields }))
}

function updated(patch: Partial<Task>): void {
  task = { ...task, ...patch }
  logEvent({ type: EventType.TaskUpdated, task })
}

const TOOL_CALL: ToolCallEvent = {
  kind: ToolEventKind.ToolCall,
  id: 'event-1',
  taskId: 'task-1',
  turn: 2,
  createdAt: 10_000,
  name: 'Bash',
  input: { command: 'npm test' },
  output: null,
  state: ToolCallState.Running,
  finishedAt: null,
  toolUseId: 'toolu_01',
  parentToolUseId: null,
}

const QUESTION_SET: QuestionSet = {
  id: 'questions-1',
  taskId: 'task-1',
  turn: 1,
  questions: [{ kind: QuestionKind.Text, prompt: 'Which branch?' }],
  state: QuestionSetState.Open,
  reply: null,
  createdAt: 3_000,
  closedAt: null,
}

describe('task updates', () => {
  it('logs a task it has not seen as created', () => {
    logEvent({ type: EventType.TaskUpdated, task: { ...task, id: 'task-2' } })

    expect(logged()).toEqual([
      {
        level: LogLevel.Info,
        scope: LogScope.Task,
        message: 'task created',
        fields: {
          taskId: 'task-2',
          workspaceId: task.workspaceId,
          state: task.state,
          activity: task.activity,
          model: task.model,
          effort: task.effort,
        },
      },
    ])
  })

  it('logs its state and activity changing, from what they were', () => {
    updated({ activity: TaskActivity.Working })
    updated({ activity: TaskActivity.Waiting })
    updated({ state: TaskState.Done })

    expect(logged()).toEqual([
      {
        level: LogLevel.Info,
        scope: LogScope.Task,
        message: 'task activity changed',
        fields: { taskId: task.id, from: TaskActivity.Waiting, to: TaskActivity.Working },
      },
      {
        level: LogLevel.Info,
        scope: LogScope.Task,
        message: 'task activity changed',
        fields: { taskId: task.id, from: TaskActivity.Working, to: TaskActivity.Waiting },
      },
      {
        level: LogLevel.Info,
        scope: LogScope.Task,
        message: 'task state changed',
        fields: { taskId: task.id, from: TaskState.Active, to: TaskState.Done },
      },
    ])
  })

  it('logs an error as a warning with its details cut short, and its clearing', () => {
    const error = {
      kind: AgentErrorKind.Transient,
      source: TaskErrorSource.Api,
      status: 529,
      code: 'overloaded',
      details: 'x'.repeat(600),
      retries: 3,
      retryingMs: 12_000,
    }
    updated({ activity: TaskActivity.Error, error })
    updated({ activity: TaskActivity.Working, error: null })

    expect(log.withMessage('task error')).toEqual([
      expect.objectContaining({
        level: LogLevel.Warn,
        fields: { taskId: task.id, error: { ...error, details: `${'x'.repeat(500)}… (100 more characters)` } },
      }),
    ])
    expect(log.withMessage('task error cleared')).toHaveLength(1)
  })

  it('logs a pause, a retry and a question waiting, and each ending', () => {
    const pause = { reason: PauseReason.Offline, details: 'fetch failed', since: 1_000, resumesAt: 31_000, checks: 0 }
    const retrying = { attempt: 2, maxRetries: 10, since: 1_000 }
    updated({ pause })
    updated({ pause: null })
    updated({ retrying })
    updated({ retrying: null })
    updated({ asking: true })
    updated({ asking: false })
    updated({ awaitingPermission: true })
    updated({ awaitingPermission: false })
    updated({ permissionMode: PermissionMode.AskBeforeEdits })

    expect(logged().map(({ message, fields }) => ({ message, fields }))).toEqual([
      { message: 'task paused', fields: { taskId: task.id, pause } },
      { message: 'task pause cleared', fields: { taskId: task.id } },
      { message: 'task retrying', fields: { taskId: task.id, retrying } },
      { message: 'task retry over', fields: { taskId: task.id } },
      { message: 'task asking', fields: { taskId: task.id } },
      { message: 'task no longer asking', fields: { taskId: task.id } },
      { message: 'task awaiting permission', fields: { taskId: task.id } },
      { message: 'task no longer awaiting permission', fields: { taskId: task.id } },
      {
        message: 'task permissionMode changed',
        fields: { taskId: task.id, from: PermissionMode.AllowAll, to: PermissionMode.AskBeforeEdits },
      },
    ])
  })

  it('logs its title and session id changing, from what they were', () => {
    updated({ title: 'Fix the login redirect', sessionId: 'session-1' })

    expect(logged()).toEqual([
      expect.objectContaining({
        message: 'task title changed',
        fields: { taskId: task.id, from: '', to: 'Fix the login redirect' },
      }),
      expect.objectContaining({
        message: 'task sessionId changed',
        fields: { taskId: task.id, from: null, to: 'session-1' },
      }),
    ])
  })

  it('notes any other change at debug level, by the fields that changed, and nothing when none did', () => {
    updated({ contextUsedTokens: 41_000, unread: true })
    updated({})

    expect(logged()).toEqual([
      {
        level: LogLevel.Debug,
        scope: LogScope.Task,
        message: 'task updated',
        fields: { taskId: task.id, changed: ['unread', 'contextUsedTokens'] },
      },
    ])
  })

  it('logs a deleted task, and forgets it', () => {
    logEvent({ type: EventType.TaskDeleted, taskId: task.id })
    logEvent({ type: EventType.TaskUpdated, task })

    expect(logged().map(({ message }) => message)).toEqual(['task deleted', 'task created'])
  })
})

describe('the chat', () => {
  it('logs a message at info level, and its text, cut short, at debug', () => {
    const summary = { durationMs: 1_500, filesChanged: 1, linesAdded: 2, linesRemoved: 0 }
    logEvent({
      type: EventType.MessageAppended,
      message: {
        id: 'message-1',
        taskId: 'task-1',
        role: MessageRole.Agent,
        body: 'y'.repeat(700),
        turn: 3,
        createdAt: 5_000,
        summary,
        images: [{ id: 'image-1', mediaType: ImageMediaType.Png }],
      },
    })

    expect(logged()).toEqual([
      {
        level: LogLevel.Info,
        scope: LogScope.Chat,
        message: 'message appended',
        fields: {
          taskId: 'task-1',
          messageId: 'message-1',
          role: MessageRole.Agent,
          turn: 3,
          chars: 700,
          images: 1,
          summary,
        },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Chat,
        message: 'message text',
        fields: {
          taskId: 'task-1',
          messageId: 'message-1',
          role: MessageRole.Agent,
          text: `${'y'.repeat(500)}… (200 more characters)`,
        },
      },
    ])
  })

  it('logs the queue changing, with each queued message at debug', () => {
    logEvent({
      type: EventType.QueueChanged,
      taskId: 'task-1',
      queuedMessages: [{ id: 'queued-1', taskId: 'task-1', body: 'Also the docs.', createdAt: 1, images: [] }],
    })

    expect(logged()).toEqual([
      { level: LogLevel.Info, scope: LogScope.Chat, message: 'queue changed', fields: { taskId: 'task-1', queued: 1 } },
      {
        level: LogLevel.Debug,
        scope: LogScope.Chat,
        message: 'queued message',
        fields: { taskId: 'task-1', queuedMessageId: 'queued-1', text: 'Also the docs.' },
      },
    ])
  })
})

describe('the tool log', () => {
  it('logs a tool call starting, with its input at debug', () => {
    logEvent({ type: EventType.ToolEventAppended, toolEvent: TOOL_CALL })

    expect(logged()).toEqual([
      {
        level: LogLevel.Info,
        scope: LogScope.Tools,
        message: 'tool call started',
        fields: { taskId: 'task-1', turn: 2, toolUseId: 'toolu_01', name: 'Bash', parentToolUseId: null },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Tools,
        message: 'tool call input',
        fields: { taskId: 'task-1', turn: 2, toolUseId: 'toolu_01', input: '{"command":"npm test"}' },
      },
    ])
  })

  it('logs a tool call finishing, how long it took, and its output at debug; a failed one as a warning', () => {
    const done = { ...TOOL_CALL, state: ToolCallState.Done, output: 'All 12 tests passed.', finishedAt: 12_500 }
    logEvent({ type: EventType.ToolEventUpdated, toolEvent: done })
    logEvent({
      type: EventType.ToolEventUpdated,
      toolEvent: { ...TOOL_CALL, toolUseId: 'toolu_02', state: ToolCallState.Error, output: null },
    })

    expect(logged()).toEqual([
      expect.objectContaining({
        level: LogLevel.Info,
        message: 'tool call finished',
        fields: expect.objectContaining({
          toolUseId: 'toolu_01',
          state: ToolCallState.Done,
          durationMs: 2_500,
        }) as unknown,
      }),
      expect.objectContaining({
        level: LogLevel.Debug,
        message: 'tool call output',
        fields: expect.objectContaining({ output: 'All 12 tests passed.' }) as unknown,
      }),
      expect.objectContaining({
        level: LogLevel.Warn,
        message: 'tool call finished',
        fields: expect.objectContaining({
          toolUseId: 'toolu_02',
          state: ToolCallState.Error,
          durationMs: null,
        }) as unknown,
      }),
      expect.objectContaining({
        message: 'tool call output',
        fields: expect.objectContaining({ output: '' }) as unknown,
      }),
    ])
  })

  it('logs a tool call that arrives already finished as both started and finished', () => {
    const toolEvent = { ...TOOL_CALL, state: ToolCallState.Error, output: 'API Error: 529', finishedAt: 10_000 }
    logEvent({ type: EventType.ToolEventAppended, toolEvent })

    expect(logged().map(({ message }) => message)).toEqual([
      'tool call started',
      'tool call input',
      'tool call finished',
      'tool call output',
    ])
  })

  it('logs narration at debug, and dividers and compactions at info', () => {
    const base = { id: 'event-2', taskId: 'task-1', turn: 2, createdAt: 1 }
    logEvent({
      type: EventType.ToolEventAppended,
      toolEvent: { ...base, kind: ToolEventKind.Narration, text: 'Reading the tests.', parentToolUseId: 'toolu_09' },
    })
    logEvent({
      type: EventType.ToolEventAppended,
      toolEvent: { ...base, kind: ToolEventKind.Divider, dividerKind: DividerKind.Resumed },
    })
    const compaction = {
      ...base,
      kind: ToolEventKind.Compaction,
      trigger: CompactionTrigger.Manual,
      state: ToolCallState.Running,
      preTokens: null,
      postTokens: null,
      windowTokens: 200_000,
      summary: null,
    } as const
    logEvent({ type: EventType.ToolEventAppended, toolEvent: compaction })
    logEvent({
      type: EventType.ToolEventUpdated,
      toolEvent: { ...compaction, state: ToolCallState.Done, preTokens: 180_000, postTokens: 40_000 },
    })

    expect(logged()).toEqual([
      {
        level: LogLevel.Debug,
        scope: LogScope.Tools,
        message: 'narration',
        fields: { taskId: 'task-1', turn: 2, parentToolUseId: 'toolu_09', text: 'Reading the tests.' },
      },
      {
        level: LogLevel.Info,
        scope: LogScope.Tools,
        message: 'divider',
        fields: { taskId: 'task-1', turn: 2, dividerKind: DividerKind.Resumed },
      },
      expect.objectContaining({
        message: 'compaction started',
        fields: expect.objectContaining({ trigger: CompactionTrigger.Manual, state: ToolCallState.Running }) as unknown,
      }),
      expect.objectContaining({
        message: 'compaction finished',
        fields: expect.objectContaining({ preTokens: 180_000, postTokens: 40_000, windowTokens: 200_000 }) as unknown,
      }),
    ])
  })

  it('logs todos, artifacts, handoff notes, shown files and open files', () => {
    logEvent({ type: EventType.TodosChanged, taskId: 'task-1', todos: null })
    logEvent({ type: EventType.TodosChanged, taskId: 'task-1', todos: { items: [], updatedAt: 1 } })
    logEvent({ type: EventType.ArtifactsChanged, taskId: 'task-1', artifacts: [] })
    logEvent({
      type: EventType.HandoffChanged,
      taskId: 'task-1',
      handoff: { taskId: 'task-1', body: 'Private notes', addedAt: 1 },
    })
    logEvent({ type: EventType.HandoffChanged, taskId: 'task-1', handoff: null })
    logEvent({ type: EventType.FileShown, taskId: 'task-1', path: 'src/date.ts', line: 12 })
    logEvent({
      type: EventType.OpenFilesChanged,
      openFiles: { taskId: 'task-1', paths: ['src/date.ts'], activePath: 'src/date.ts' },
    })

    expect(logged()).toEqual([
      expect.objectContaining({ message: 'todos changed', fields: { taskId: 'task-1', todos: 0 } }),
      expect.objectContaining({ message: 'todos changed', fields: { taskId: 'task-1', todos: 0 } }),
      expect.objectContaining({ message: 'artifacts changed', fields: { taskId: 'task-1', artifacts: 0 } }),
      // Never the note itself.
      expect.objectContaining({ message: 'handoff set', fields: { taskId: 'task-1' } }),
      expect.objectContaining({ message: 'handoff cleared', fields: { taskId: 'task-1' } }),
      expect.objectContaining({
        message: 'file shown',
        fields: { taskId: 'task-1', path: 'src/date.ts', line: 12 },
      }),
      expect.objectContaining({
        level: LogLevel.Debug,
        message: 'open files changed',
        fields: { taskId: 'task-1', open: 1, activePath: 'src/date.ts' },
      }),
    ])
  })
})

describe('questions', () => {
  it('logs questions asked, with the questions at debug', () => {
    logEvent({ type: EventType.QuestionOpened, questionSet: QUESTION_SET })

    expect(logged()).toEqual([
      {
        level: LogLevel.Info,
        scope: LogScope.Questions,
        message: 'questions asked',
        fields: { taskId: 'task-1', questionSetId: 'questions-1', turn: 1, count: 1, state: QuestionSetState.Open },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Questions,
        message: 'question text',
        fields: {
          taskId: 'task-1',
          questionSetId: 'questions-1',
          turn: 1,
          questions: '[{"kind":"text","prompt":"Which branch?"}]',
        },
      },
    ])
  })

  it('logs questions answered with the card or in words, with the reply at debug, and withdrawn', () => {
    const answered = { ...QUESTION_SET, state: QuestionSetState.Answered }
    logEvent({
      type: EventType.QuestionAnswered,
      questionSet: { ...answered, reply: { kind: QuestionReplyKind.Answers, answers: { 0: 'main' } } },
    })
    logEvent({
      type: EventType.QuestionAnswered,
      questionSet: { ...answered, reply: { kind: QuestionReplyKind.FreeText, text: 'Use main.' } },
    })
    logEvent({
      type: EventType.QuestionWithdrawn,
      questionSet: { ...QUESTION_SET, state: QuestionSetState.Withdrawn },
    })

    expect(logged().map(({ message, fields }) => [message, fields.reply ?? fields.state])).toEqual([
      ['questions answered', QuestionSetState.Answered],
      ['question reply', '{"0":"main"}'],
      ['questions answered', QuestionSetState.Answered],
      ['question reply', 'Use main.'],
      ['questions withdrawn', QuestionSetState.Withdrawn],
    ])
  })
})

describe('permission requests', () => {
  const REQUEST: PermissionRequest = {
    id: 'request-1',
    taskId: 'task-1',
    turn: 2,
    toolUseId: 'toolu_1',
    agentId: 'ac2cfaf3',
    toolName: 'Bash',
    input: { command: 'npm test' },
    title: null,
    displayName: 'Bash',
    description: null,
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    state: PermissionRequestState.Open,
    denyNote: null,
    grantedRule: null,
    createdAt: 1_000,
    closedAt: null,
  }

  it('logs a request opened, with its input at debug, then allowed, denied with its note at debug, and withdrawn', () => {
    const closed = { ...REQUEST, closedAt: 2_000 }
    logEvent({ type: EventType.PermissionOpened, permissionRequest: REQUEST })
    logEvent({
      type: EventType.PermissionAnswered,
      permissionRequest: { ...closed, state: PermissionRequestState.Allowed },
    })
    logEvent({
      type: EventType.PermissionAnswered,
      permissionRequest: { ...closed, state: PermissionRequestState.Denied, denyNote: 'Use pnpm.' },
    })
    logEvent({
      type: EventType.PermissionAnswered,
      permissionRequest: { ...closed, state: PermissionRequestState.Denied },
    })
    logEvent({
      type: EventType.PermissionWithdrawn,
      permissionRequest: { ...closed, state: PermissionRequestState.Withdrawn },
    })

    const where = { taskId: 'task-1', permissionRequestId: 'request-1', turn: 2 }
    expect(logged()).toEqual([
      {
        level: LogLevel.Info,
        scope: LogScope.Permissions,
        message: 'permission requested',
        fields: { ...where, toolUseId: 'toolu_1', agentId: 'ac2cfaf3', toolName: 'Bash' },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Permissions,
        message: 'permission input',
        fields: { ...where, toolUseId: 'toolu_1', input: '{"command":"npm test"}' },
      },
      {
        level: LogLevel.Info,
        scope: LogScope.Permissions,
        message: 'permission allowed',
        fields: { ...where, toolUseId: 'toolu_1', toolName: 'Bash', forTask: false },
      },
      {
        level: LogLevel.Info,
        scope: LogScope.Permissions,
        message: 'permission denied',
        fields: { ...where, toolUseId: 'toolu_1', toolName: 'Bash', withNote: true },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Permissions,
        message: 'permission deny note',
        fields: { ...where, note: 'Use pnpm.' },
      },
      {
        level: LogLevel.Info,
        scope: LogScope.Permissions,
        message: 'permission denied',
        fields: { ...where, toolUseId: 'toolu_1', toolName: 'Bash', withNote: false },
      },
      {
        level: LogLevel.Info,
        scope: LogScope.Permissions,
        message: 'permission withdrawn',
        fields: { ...where, toolUseId: 'toolu_1', toolName: 'Bash' },
      },
    ])
  })

  it('logs a request allowed for the task, with the rule it granted at debug', () => {
    logEvent({
      type: EventType.PermissionAnswered,
      permissionRequest: {
        ...REQUEST,
        state: PermissionRequestState.Allowed,
        grantedRule: { toolName: 'Bash', ruleContent: 'npm test *' },
        closedAt: 2_000,
      },
    })

    const where = { taskId: 'task-1', permissionRequestId: 'request-1', turn: 2 }
    expect(logged()).toEqual([
      {
        level: LogLevel.Info,
        scope: LogScope.Permissions,
        message: 'permission allowed',
        fields: { ...where, toolUseId: 'toolu_1', toolName: 'Bash', forTask: true },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Permissions,
        message: 'permission rule granted',
        fields: { ...where, rule: 'Bash(npm test *)' },
      },
    ])
  })
})

describe('the rest of the app', () => {
  it('logs workspaces, settings, the window and the terminal, and never a terminal’s output', () => {
    const workspace = { id: 'ws-1', name: 'Acme API', rootPath: '/code/acme-api', createdAt: 1, lastOpenedAt: 1 }
    const events: GladeEvent[] = [
      { type: EventType.WorkspaceUpdated, workspace },
      { type: EventType.WorkspaceRemoved, workspaceId: 'ws-1' },
      { type: EventType.SettingsChanged, settings: DEFAULT_SETTINGS },
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.SelectedTaskId, value: 'task-1' } },
      { type: EventType.MenuCommand, command: appCommand(AppCommandId.NewTask) },
      { type: EventType.TaskOpenRequested, taskId: 'task-1' },
      { type: EventType.TerminalTabsChanged, tabs: [] },
      { type: EventType.TerminalCleared, tabId: 'term-1' },
      { type: EventType.TerminalOutput, tabId: 'term-1', offset: 0, data: 'secret typed here' },
      // The plugins log themselves, in their own scope.
      { type: EventType.PluginsChanged, plugins: [] },
      { type: EventType.PluginStatusChanged, id: 'nekomata', text: '5 cats' },
      // What's in flight, which only the menu bar popover is sent: its tasks are logged as they change.
      {
        type: EventType.MenuBarChanged,
        snapshot: {
          needsYou: [],
          working: [],
          recent: [{ seq: 1, taskId: 'task-1', title: 'Add rate limiting', body: 'secret reply', sentAt: 1 }],
        },
      },
    ]
    for (const event of events) logEvent(event)

    expect(logged().map(({ level, scope, message }) => `${level} ${scope} ${message}`)).toEqual([
      'info app workspace updated',
      'info app workspace removed',
      'info app settings changed',
      'debug app ui state changed',
      'debug app menu command',
      'info app task open requested',
      'debug terminal terminal tabs changed',
      'debug terminal terminal cleared',
    ])
    expect(log.withMessage('workspace updated')[0]?.fields).toEqual({
      workspaceId: 'ws-1',
      name: 'Acme API',
      rootPath: '/code/acme-api',
    })
    expect(JSON.stringify(log.records)).not.toContain('secret typed here')
    expect(JSON.stringify(log.records)).not.toContain('secret reply')
  })
})
