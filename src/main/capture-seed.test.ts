import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentErrorKind,
  DividerKind,
  MessageRole,
  PauseReason,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
} from '../shared/domain'
import { applySeed, readSeed, type CaptureSeed } from './capture-seed'
import { listMessages } from './db/repositories/messages'
import { getOpenFiles } from './db/repositories/open-files'
import { listQueuedMessages } from './db/repositories/queued-messages'
import { listToolEvents } from './db/repositories/tool-events'
import { listTasks } from './db/repositories/tasks'
import { getUiState } from './db/repositories/ui-state'
import { listWorkspaces } from './db/repositories/workspaces'
import { openTestDatabase, type TestDatabase } from './db/repositories/test-database'
import { DEFAULT_EFFORT, DEFAULT_MODEL } from './tasks/defaults'

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

  it('reads the open file fixture, its workspace a folder beside it', () => {
    const seed = readSeed(join(FIXTURES, 'open-file.json'))

    expect(seed.workspace.rootPath).toBe(join(FIXTURES, 'open-file-workspace'))
    expect(seed.uiState).toEqual({ [UiStateKey.RightPanelTab]: 'files', [UiStateKey.RightPanelWidth]: '780' })
    expect(seed.tasks.find((task) => task.selected)?.openFiles?.activePath).toBe('docs/rate-limits.md')
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
        model: DEFAULT_MODEL,
        effort: DEFAULT_EFFORT,
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

  it('opens a task’s files, showing the first unless told which, and sets more UI state', () => {
    const { db } = database

    applySeed(db, {
      ...SEED,
      tasks: [
        { title: 'Shows one', minutesAgo: 0, openFiles: { paths: ['a.md', 'b.md'], activePath: 'b.md' } },
        { title: 'Shows the first', minutesAgo: 0, openFiles: { paths: ['a.md'] } },
        { title: 'Opens none', minutesAgo: 0, openFiles: { paths: [] } },
      ],
      uiState: { [UiStateKey.RightPanelTab]: 'files' },
    })

    const workspaceId = listWorkspaces(db)[0]?.id ?? ''
    const byTitle = Object.fromEntries(listTasks(db, workspaceId).map((task) => [task.title, task.id]))
    expect(getOpenFiles(db, byTitle['Shows one'] ?? '')).toMatchObject({ paths: ['a.md', 'b.md'], activePath: 'b.md' })
    expect(getOpenFiles(db, byTitle['Shows the first'] ?? '').activePath).toBe('a.md')
    expect(getOpenFiles(db, byTitle['Opens none'] ?? '').activePath).toBeNull()
    expect(getUiState(db, UiStateKey.RightPanelTab)).toBe('files')
  })

  it('selects nothing unless a task asks to be', () => {
    const { db } = database

    applySeed(db, { ...SEED, tasks: [{ title: 'Only', minutesAgo: 0 }] })

    expect(getUiState(db, UiStateKey.SelectedTaskId)).toBeUndefined()
    expect(getUiState(db, UiStateKey.RelaunchNotice)).toBeUndefined()
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
      { kind: ToolEventKind.Narration, text: 'Looking around.', createdAt: NOW - 29 * MINUTE },
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

  it('writes dividers, failed calls, and a subagent’s calls under their parent', () => {
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
              },
              {
                kind: ToolEventKind.ToolCall,
                name: 'Bash',
                input: { command: 'make' },
                output: 'Exit 2',
                failed: true,
                parentToolUseId: 'agent-1',
                turn: 2,
                minutesAgo: 7,
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
      { kind: ToolEventKind.ToolCall, toolUseId: 'agent-1', state: ToolCallState.Done, parentToolUseId: null },
      { kind: ToolEventKind.ToolCall, output: 'Exit 2', state: ToolCallState.Error, parentToolUseId: 'agent-1' },
    ])
  })
})
