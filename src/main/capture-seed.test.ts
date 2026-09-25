import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentErrorKind,
  CompactionTrigger,
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionDestination,
  PermissionMode,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
} from '../shared/domain'
import { applySeed, readSeed, type CaptureSeed } from './capture-seed'
import { listArtifacts } from './db/repositories/artifacts'
import { listMessages } from './db/repositories/messages'
import { listPermissionRequests } from './db/repositories/permission-requests'
import { getOpenFiles } from './db/repositories/open-files'
import { listQueuedMessages } from './db/repositories/queued-messages'
import { listTaskPermissionRules } from './db/repositories/task-permission-rules'
import { listToolEvents } from './db/repositories/tool-events'
import { listTasks } from './db/repositories/tasks'
import { getUiState } from './db/repositories/ui-state'
import { listWorkspaces } from './db/repositories/workspaces'
import { openTestDatabase, type TestDatabase } from './db/repositories/test-database'
import { DEFAULT_SETTINGS } from '../shared/settings'

const FIXTURES = join(import.meta.dirname, '..', '..', 'scripts', 'fixtures')
const FIXTURE = join(FIXTURES, 'task-workspace.json')
const NOW = 10_000_000
const MINUTE = 60_000

const SEED: CaptureSeed = {
  workspace: { name: 'Acme API', rootPath: '/Users/sample/code/api' },
  tasks: [
    { title: 'Add rate limiting', status: 'Waiting on you', minutesAgo: 4, startedMinutesAgo: 42, selected: true },
    {
      title: 'Move uploads',
      activity: TaskActivity.Working,
      contextUsedTokens: 76_000,
      contextWindowTokens: 200_000,
      minutesAgo: 30,
    },
    {
      title: 'Upgrade Django',
      objective: 'Move to 5.2',
      state: TaskState.Done,
      pinned: true,
      unread: true,
      minutesAgo: 60,
    },
  ],
}

describe('readSeed', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'glade-seed-'))
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  function write(content: string): string {
    const path = join(folder, 'seed.json')
    writeFileSync(path, content)
    return path
  }

  it('reads a fixture', () => {
    expect(readSeed(write(JSON.stringify(SEED)))).toEqual(SEED)
  })

  it('reads the task workspace fixture', () => {
    expect(readSeed(FIXTURE).workspace.name).toBe('Acme API')
  })

  it('reads the mark done fixture', () => {
    expect(readSeed(join(FIXTURES, 'mark-done.json')).tasks.find((task) => task.selected)?.state).toBe(TaskState.Done)
  })

  it('reads the agent working fixture', () => {
    expect(readSeed(join(FIXTURES, 'agent-working.json')).tasks[0]?.activity).toBe(TaskActivity.Working)
  })

  it('reads the relaunch fixture', () => {
    expect(readSeed(join(FIXTURES, 'relaunch.json')).tasks.filter((task) => task.resumedAfterCrash)).toHaveLength(2)
  })

  it('reads the needs you fixture', () => {
    expect(readSeed(join(FIXTURES, 'needs-you.json')).tasks.filter((task) => task.unread)).toHaveLength(1)
  })

  it('reads the error fixture', () => {
    const selected = readSeed(join(FIXTURES, 'error.json')).tasks.find((task) => task.selected)
    expect(selected).toMatchObject({ activity: TaskActivity.Error, error: { status: 529, code: 'overloaded' } })
  })

  it('reads the usage limit fixture', () => {
    const paused = readSeed(join(FIXTURES, 'usage-limit.json')).tasks.filter((task) => task.pause !== undefined)
    expect(paused).toHaveLength(3)
    expect(paused.every((task) => task.activity === TaskActivity.Paused)).toBe(true)
  })

  it('reads the todos fixture, which opens the Todos tab', () => {
    const seed = readSeed(join(FIXTURES, 'todos.json'))
    expect(seed.panelTab).toBe('todos')
    expect(seed.tasks.find((task) => task.selected)?.title).toBe('Move image uploads to S3')
  })

  it('reads the compaction fixture', () => {
    const selected = readSeed(join(FIXTURES, 'compaction.json')).tasks.find((task) => task.selected)
    expect(selected?.toolEvents?.filter((event) => event.kind === ToolEventKind.Compaction)).toMatchObject([
      { trigger: CompactionTrigger.Auto, preTokens: 198_000, postTokens: 41_000 },
    ])
  })

  it('reads the relaunch fixture’s interrupted call and the usage limit fixture’s paused one', () => {
    const states = (fixture: string): unknown[] =>
      (readSeed(join(FIXTURES, fixture)).tasks.find((task) => task.selected)?.toolEvents ?? []).map(
        (event) => event.kind === ToolEventKind.ToolCall && event.state,
      )
    expect(states('relaunch.json')).toContain(ToolCallState.Interrupted)
    expect(states('usage-limit.json')).toContain(ToolCallState.Paused)
  })

  it('reads the artifacts fixture, its workspace holding the files it declares', () => {
    const seed = readSeed(join(FIXTURES, 'artifacts.json'))

    expect(seed.workspace.rootPath).toBe(join(FIXTURES, 'artifacts-workspace'))
    const artifacts = seed.tasks.find((task) => task.selected)?.artifacts ?? []
    expect(artifacts.map(({ title }) => title)).toEqual(['Release notes 2.4', 'Upgrade guide', 'Announcement email'])
    for (const { path } of artifacts) expect(existsSync(join(seed.workspace.rootPath, path))).toBe(true)
  })

  it('reads the open file fixture, its workspace a folder beside it', () => {
    const seed = readSeed(join(FIXTURES, 'open-file.json'))

    expect(seed.workspace.rootPath).toBe(join(FIXTURES, 'open-file-workspace'))
    expect(seed).toMatchObject({ panelTab: 'files', panelWidth: 780 })
    expect(seed.tasks.find((task) => task.selected)?.openFiles?.activePath).toBe('docs/rate-limits.md')
  })

  it('reads the permission card fixture: a task in the ask mode, its requests open and closed', () => {
    const seed = readSeed(join(FIXTURES, 'permission-card.json'))
    const task = seed.tasks.find((one) => one.selected)

    expect(task?.permissionMode).toBe(PermissionMode.AskBeforeEdits)
    expect(task?.permissionRequests?.map((request) => request.state ?? 'open')).toEqual([
      PermissionRequestState.Allowed,
      PermissionRequestState.Allowed,
      PermissionRequestState.Denied,
      PermissionRequestState.Withdrawn,
      'open',
      'open',
    ])
    expect(task?.permissionRequests?.filter((request) => request.forTask === true)).toHaveLength(1)
    expect(task?.permissionRequests?.find((request) => request.toolUseId === 'tests')?.suggestedRule).toBe('npm test *')
  })

  it('reads the e2e tool log fixture', () => {
    const seed = readSeed(join(import.meta.dirname, '..', '..', 'e2e', 'seeds', 'tool-log.json'))
    expect(seed.tasks[0]?.toolEvents).toHaveLength(11)
  })

  it('refuses a fixture that is missing or not JSON', () => {
    expect(() => readSeed(join(folder, 'missing.json'))).toThrow(/^the seed .*missing\.json can't be read: /)
    expect(() => readSeed(write('{'))).toThrow(/can't be read: /)
  })

  it('refuses a fixture that is not valid', () => {
    expect(() => readSeed(write(JSON.stringify({ ...SEED, extra: 1 })))).toThrow(/is invalid: /)
    expect(() => readSeed(write(JSON.stringify({ ...SEED, tasks: [{ title: 'x', minutesAgo: -1 }] })))).toThrow(
      /is invalid: /,
    )
  })
})

describe('applySeed', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = openTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  it('adds the workspace, opened, and its tasks, updated the given minutes ago', () => {
    const { db } = database

    applySeed(db, SEED, NOW)

    const [workspace] = listWorkspaces(db)
    expect(workspace).toMatchObject({ name: 'Acme API', rootPath: '/Users/sample/code/api', lastOpenedAt: NOW })
    const tasks = listTasks(db, workspace?.id ?? '')
    expect(tasks).toMatchObject([
      {
        title: 'Add rate limiting',
        objective: '',
        status: 'Waiting on you',
        state: TaskState.Active,
        pinned: false,
        unread: false,
        model: DEFAULT_SETTINGS.defaultModel,
        effort: DEFAULT_SETTINGS.defaultEffort,
        createdAt: NOW - 42 * MINUTE,
        updatedAt: NOW - 4 * MINUTE,
        statusUpdatedAt: NOW - 4 * MINUTE,
        doneAt: null,
        activity: TaskActivity.Waiting,
        contextUsedTokens: 0,
        contextWindowTokens: 1_000_000,
        sessionId: 'seed-session-0',
      },
      {
        title: 'Move uploads',
        activity: TaskActivity.Working,
        contextUsedTokens: 76_000,
        contextWindowTokens: 200_000,
      },
      {
        title: 'Upgrade Django',
        objective: 'Move to 5.2',
        state: TaskState.Done,
        pinned: true,
        unread: true,
        createdAt: NOW - 60 * MINUTE,
        updatedAt: NOW - 60 * MINUTE,
        doneAt: NOW - 60 * MINUTE,
      },
    ])
    expect(getUiState(db, UiStateKey.ActiveWorkspaceId)).toBe(workspace?.id)
    expect(getUiState(db, UiStateKey.SelectedTaskId)).toBe(tasks[0]?.id)
  })

  it('declares a task’s artifacts, in order, marking each file that’s there as changed when it was declared', () => {
    const { db } = database
    const root = mkdtempSync(join(tmpdir(), 'glade-seed-artifacts-'))
    try {
      mkdirSync(join(root, 'docs'))
      writeFileSync(join(root, 'docs', 'notes.md'), '# Notes\n')
      const now = 100 * 60_000

      applySeed(
        db,
        {
          ...SEED,
          workspace: { name: 'Acme API', rootPath: root },
          tasks: [
            {
              title: 'Draft release notes',
              minutesAgo: 0,
              artifacts: [
                { path: 'docs/notes.md', title: 'Notes', minutesAgo: 12 },
                { path: 'out/gone.txt', title: 'Gone', minutesAgo: 6 },
              ],
            },
          ],
        },
        now,
      )

      const taskId = listTasks(db, listWorkspaces(db)[0]?.id ?? '')[0]?.id ?? ''
      expect(listArtifacts(db, taskId).map(({ path, title, addedAt }) => [path, title, addedAt])).toEqual([
        ['docs/notes.md', 'Notes', now - 12 * 60_000],
        ['out/gone.txt', 'Gone', now - 6 * 60_000],
      ])
      expect(statSync(join(root, 'docs', 'notes.md')).mtimeMs).toBe(now - 12 * 60_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('opens a task’s files, showing the first unless told which, and sets the panel’s width', () => {
    const { db } = database

    applySeed(db, {
      ...SEED,
      tasks: [
        { title: 'Shows one', minutesAgo: 0, openFiles: { paths: ['a.md', 'b.md'], activePath: 'b.md' } },
        { title: 'Shows the first', minutesAgo: 0, openFiles: { paths: ['a.md'] } },
        { title: 'Opens none', minutesAgo: 0, openFiles: { paths: [] } },
      ],
      panelWidth: 780,
    })

    const workspaceId = listWorkspaces(db)[0]?.id ?? ''
    const byTitle = Object.fromEntries(listTasks(db, workspaceId).map((task) => [task.title, task.id]))
    expect(getOpenFiles(db, byTitle['Shows one'] ?? '')).toMatchObject({ paths: ['a.md', 'b.md'], activePath: 'b.md' })
    expect(getOpenFiles(db, byTitle['Shows the first'] ?? '').activePath).toBe('a.md')
    expect(getOpenFiles(db, byTitle['Opens none'] ?? '').activePath).toBeNull()
    expect(getUiState(db, UiStateKey.RightPanelWidth)).toBe('780')
  })

  it('selects nothing unless a task asks to be', () => {
    const { db } = database

    applySeed(db, { ...SEED, tasks: [{ title: 'Only', minutesAgo: 0 }] })

    expect(getUiState(db, UiStateKey.SelectedTaskId)).toBeUndefined()
    expect(getUiState(db, UiStateKey.RelaunchNotice)).toBeUndefined()
    expect(getUiState(db, UiStateKey.RightPanelTab)).toBeUndefined()
    expect(getUiState(db, UiStateKey.PluginWidth)).toBeUndefined()
  })

  it('sets the plugin card’s width', () => {
    const { db } = database

    applySeed(db, { ...SEED, tasks: [], pluginWidth: 960 })

    expect(getUiState(db, UiStateKey.PluginWidth)).toBe('960')
  })

  it('opens the right panel on the tab it names', () => {
    const { db } = database

    applySeed(db, { ...SEED, panelTab: 'subagents', tasks: [] })

    expect(getUiState(db, UiStateKey.RightPanelTab)).toBe('subagents')
  })

  it('collapses the panels it names, and leaves the rest as they are', () => {
    const { db } = database

    applySeed(db, { ...SEED, collapsed: { sidebar: true, bottomBar: false }, tasks: [] })

    expect(getUiState(db, UiStateKey.SidebarCollapsed)).toBe('true')
    expect(getUiState(db, UiStateKey.BottomBarCollapsed)).toBe('false')
    expect(getUiState(db, UiStateKey.RightPanelCollapsed)).toBeUndefined()
  })

  it('names the tasks resumed after a crash in the relaunch notice', () => {
    const { db } = database

    applySeed(db, {
      ...SEED,
      tasks: [
        { title: 'First', minutesAgo: 0, resumedAfterCrash: true },
        { title: 'Second', minutesAgo: 0 },
        { title: 'Third', minutesAgo: 0, resumedAfterCrash: true },
      ],
    })

    const tasks = listTasks(db, listWorkspaces(db)[0]?.id ?? '')
    const ids = ['First', 'Third'].map((title) => tasks.find((task) => task.title === title)?.id)
    expect(getUiState(db, UiStateKey.RelaunchNotice)).toBe(JSON.stringify({ taskIds: ids }))
  })

  it('gives a titled task a session, since it has run, and a new, untitled one none', () => {
    const { db } = database

    applySeed(db, { ...SEED, tasks: [{ title: '', minutesAgo: 0 }] })

    expect(listTasks(db, listWorkspaces(db)[0]?.id ?? '')[0]?.sessionId).toBeNull()
  })

  it("writes a task's chat log and tool log, the tool calls done when they have an output", () => {
    const { db } = database

    applySeed(
      db,
      {
        ...SEED,
        tasks: [
          {
            title: 'Add rate limiting',
            minutesAgo: 0,
            messages: [
              { role: MessageRole.User, body: 'Add rate limiting.', turn: 1, minutesAgo: 30 },
              {
                role: MessageRole.Agent,
                body: 'Done.',
                turn: 1,
                minutesAgo: 2,
                summary: { durationMs: 60_000, filesChanged: 1, linesAdded: 2, linesRemoved: 0 },
              },
            ],
            toolEvents: [
              { kind: ToolEventKind.Narration, text: 'Looking around.', turn: 1, minutesAgo: 29 },
              {
                kind: ToolEventKind.ToolCall,
                name: 'Read',
                input: { file_path: 'a.py' },
                output: '9 lines',
                turn: 1,
                minutesAgo: 28,
              },
              { kind: ToolEventKind.ToolCall, name: 'Bash', input: { command: 'make' }, turn: 1, minutesAgo: 3 },
            ],
            queuedMessages: ['Keep the limits per key.', 'Then update the docs.'],
          },
        ],
      },
      NOW,
    )

    const [task] = listTasks(db, listWorkspaces(db)[0]?.id ?? '')
    const taskId = task?.id ?? ''
    expect(listMessages(db, taskId)).toMatchObject([
      { role: MessageRole.User, body: 'Add rate limiting.', turn: 1, createdAt: NOW - 30 * MINUTE, summary: null },
      {
        role: MessageRole.Agent,
        body: 'Done.',
        turn: 1,
        createdAt: NOW - 2 * MINUTE,
        summary: { durationMs: 60_000, filesChanged: 1, linesAdded: 2, linesRemoved: 0 },
      },
    ])
    expect(listToolEvents(db, taskId)).toMatchObject([
      { kind: ToolEventKind.Narration, text: 'Looking around.', createdAt: NOW - 29 * MINUTE, parentToolUseId: null },
      {
        kind: ToolEventKind.ToolCall,
        name: 'Read',
        output: '9 lines',
        state: ToolCallState.Done,
        parentToolUseId: null,
      },
      { kind: ToolEventKind.ToolCall, name: 'Bash', output: null, state: ToolCallState.Running },
    ])
    expect(listQueuedMessages(db, taskId).map(({ body, createdAt }) => [body, createdAt])).toEqual([
      ['Keep the limits per key.', NOW],
      ['Then update the docs.', NOW],
    ])
  })

  it('writes a task’s permission mode, and its permission requests, open or closed as they say', () => {
    const { db } = database
    const base = { toolName: 'Bash', input: { command: 'npm test' }, turn: 1, minutesAgo: 2 }

    applySeed(
      db,
      {
        ...SEED,
        tasks: [
          {
            title: 'Run the tests',
            minutesAgo: 0,
            permissionMode: PermissionMode.AskBeforeEdits,
            permissionRequests: [
              { ...base, toolUseId: 'allowed', state: PermissionRequestState.Allowed },
              { ...base, toolUseId: 'denied', state: PermissionRequestState.Denied, denyNote: 'Not yet' },
              { ...base, toolUseId: 'bare-denied', state: PermissionRequestState.Denied },
              { ...base, toolUseId: 'withdrawn', state: PermissionRequestState.Withdrawn },
              {
                ...base,
                toolUseId: 'for-task',
                suggestedRule: 'npm test *',
                state: PermissionRequestState.Allowed,
                forTask: true,
              },
              {
                ...base,
                toolName: 'Edit',
                input: { file_path: 'a.md' },
                toolUseId: 'edit',
                state: PermissionRequestState.Allowed,
                forTask: true,
              },
              {
                ...base,
                toolUseId: 'open',
                suggestedRule: 'npm test *',
                agentId: 'a1',
                title: 'Claude wants to run npm test',
                description: 'Run the tests',
                defaultToNo: true,
                minutesAgo: 1,
              },
            ],
          },
          { title: 'Allow all by default', minutesAgo: 0 },
        ],
      },
      NOW,
    )

    const [allowing, asking] = listTasks(db, listWorkspaces(db)[0]?.id ?? '').toSorted((a, b) =>
      a.title.localeCompare(b.title),
    )
    expect(asking).toMatchObject({ permissionMode: PermissionMode.AskBeforeEdits, awaitingPermission: true })
    expect(allowing).toMatchObject({ permissionMode: PermissionMode.AllowAll, awaitingPermission: false })
    expect(listPermissionRequests(db, asking?.id ?? '')).toMatchObject([
      { toolUseId: 'allowed', state: PermissionRequestState.Allowed, closedAt: NOW - 2 * MINUTE },
      { toolUseId: 'denied', state: PermissionRequestState.Denied, denyNote: 'Not yet' },
      { toolUseId: 'bare-denied', state: PermissionRequestState.Denied, denyNote: null },
      { toolUseId: 'withdrawn', state: PermissionRequestState.Withdrawn },
      { toolUseId: 'for-task', grantedRule: { toolName: 'Bash', ruleContent: 'npm test *' } },
      { toolUseId: 'edit', grantedRule: { toolName: 'Edit' } },
      {
        toolUseId: 'open',
        suggestions: [
          {
            type: PermissionUpdateType.AddRules,
            rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
            behavior: PermissionRuleBehavior.Allow,
            destination: PermissionDestination.LocalSettings,
          },
        ],
        agentId: 'a1',
        title: 'Claude wants to run npm test',
        description: 'Run the tests',
        defaultToNo: true,
        state: PermissionRequestState.Open,
        createdAt: NOW - MINUTE,
        closedAt: null,
      },
    ])
    expect(listPermissionRequests(db, asking?.id ?? '')[0]?.grantedRule).toBeNull()
    expect(listTaskPermissionRules(db, asking?.id ?? '').map(({ rule }) => rule)).toEqual([
      { toolName: 'Bash', ruleContent: 'npm test *' },
      { toolName: 'Edit' },
    ])
  })

  it('refuses a sample allowed for the task that no rule could be granted for', () => {
    const request = {
      toolName: 'Bash',
      input: { command: 'npm test' },
      toolUseId: 'bare',
      state: PermissionRequestState.Allowed,
      forTask: true,
      turn: 1,
      minutesAgo: 1,
    }
    expect(() => {
      applySeed(
        database.db,
        { ...SEED, tasks: [{ title: 'Run the tests', minutesAgo: 0, permissionRequests: [request] }] },
        NOW,
      )
    }).toThrow(/can't be allowed for the task/)
  })

  it('writes what stopped a task’s agent', () => {
    const { db } = database
    const error = {
      kind: AgentErrorKind.Transient,
      source: TaskErrorSource.Api,
      status: 529,
      code: 'overloaded',
      details: 'API Error: 529 Overloaded',
      retries: 3,
      retryingMs: 120_000,
    }

    applySeed(db, {
      ...SEED,
      tasks: [{ title: 'Fix flaky login test', minutesAgo: 0, activity: TaskActivity.Error, error }],
    })

    expect(listTasks(db, listWorkspaces(db)[0]?.id ?? '')).toMatchObject([{ activity: TaskActivity.Error, error }])
  })

  it('writes why a task’s turn is paused, with its resume time relative to the capture', () => {
    const { db } = database
    const pause = { reason: PauseReason.UsageLimit, resumesInMinutes: 42, details: "You've hit your session limit" }

    applySeed(
      db,
      { ...SEED, tasks: [{ title: 'Move image uploads to S3', minutesAgo: 1, activity: TaskActivity.Paused, pause }] },
      NOW,
    )

    expect(listTasks(db, listWorkspaces(db)[0]?.id ?? '')).toMatchObject([
      {
        activity: TaskActivity.Paused,
        pause: {
          reason: PauseReason.UsageLimit,
          since: NOW - 60_000,
          resumesAt: NOW + 42 * 60_000,
          checks: 0,
          details: "You've hit your session limit",
        },
      },
    ])
  })

  it('writes dividers, calls that ended how they say, and a subagent’s calls under their parent', () => {
    const { db } = database

    applySeed(
      db,
      {
        ...SEED,
        tasks: [
          {
            title: 'Add rate limiting',
            minutesAgo: 0,
            toolEvents: [
              { kind: ToolEventKind.Divider, dividerKind: DividerKind.Turn, turn: 2, minutesAgo: 9 },
              {
                kind: ToolEventKind.ToolCall,
                name: 'Agent',
                input: { description: 'Look' },
                output: 'Found it.',
                toolUseId: 'agent-1',
                turn: 2,
                minutesAgo: 8,
                finishedMinutesAgo: 5,
              },
              {
                kind: ToolEventKind.Narration,
                text: 'Building first.',
                parentToolUseId: 'agent-1',
                turn: 2,
                minutesAgo: 7.5,
              },
              {
                kind: ToolEventKind.ToolCall,
                name: 'Bash',
                input: { command: 'make' },
                output: 'Exit 2',
                state: ToolCallState.Error,
                parentToolUseId: 'agent-1',
                turn: 2,
                minutesAgo: 7,
              },
              {
                kind: ToolEventKind.ToolCall,
                name: 'Bash',
                input: { command: 'python copy.py' },
                output: 'Glade quit before this tool call finished.',
                state: ToolCallState.Interrupted,
                turn: 2,
                minutesAgo: 6,
              },
            ],
          },
        ],
      },
      NOW,
    )

    const [task] = listTasks(db, listWorkspaces(db)[0]?.id ?? '')
    expect(listToolEvents(db, task?.id ?? '')).toMatchObject([
      { kind: ToolEventKind.Divider, dividerKind: DividerKind.Turn, turn: 2, createdAt: NOW - 9 * MINUTE },
      {
        kind: ToolEventKind.ToolCall,
        toolUseId: 'agent-1',
        state: ToolCallState.Done,
        parentToolUseId: null,
        createdAt: NOW - 8 * MINUTE,
        finishedAt: NOW - 5 * MINUTE,
      },
      { kind: ToolEventKind.Narration, text: 'Building first.', parentToolUseId: 'agent-1' },
      {
        kind: ToolEventKind.ToolCall,
        output: 'Exit 2',
        state: ToolCallState.Error,
        parentToolUseId: 'agent-1',
        finishedAt: NOW - 7 * MINUTE,
      },
      { kind: ToolEventKind.ToolCall, state: ToolCallState.Interrupted, parentToolUseId: null },
    ])
  })

  it('writes compactions, done unless they say otherwise', () => {
    const { db } = database
    const compaction = { kind: ToolEventKind.Compaction, preTokens: 198_000, windowTokens: 200_000, turn: 2 } as const

    applySeed(
      db,
      {
        ...SEED,
        tasks: [
          {
            title: 'Move image uploads to S3',
            minutesAgo: 0,
            toolEvents: [
              { ...compaction, trigger: CompactionTrigger.Auto, postTokens: 41_000, minutesAgo: 30 },
              {
                ...compaction,
                trigger: CompactionTrigger.Manual,
                state: ToolCallState.Running,
                preTokens: null,
                postTokens: null,
                minutesAgo: 1,
              },
            ],
          },
        ],
      },
      NOW,
    )

    const [task] = listTasks(db, listWorkspaces(db)[0]?.id ?? '')
    expect(listToolEvents(db, task?.id ?? '')).toMatchObject([
      {
        kind: ToolEventKind.Compaction,
        trigger: CompactionTrigger.Auto,
        state: ToolCallState.Done,
        preTokens: 198_000,
        postTokens: 41_000,
        windowTokens: 200_000,
        turn: 2,
        createdAt: NOW - 30 * MINUTE,
      },
      { kind: ToolEventKind.Compaction, trigger: CompactionTrigger.Manual, state: ToolCallState.Running },
    ])
  })
})
