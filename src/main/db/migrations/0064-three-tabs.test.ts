import type { Database } from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ToolCallState, UiStateKey, WatcherKind, WatcherState } from '../../../shared/domain'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { ChildFilter, ChildKind, subagentTodo, UNFILED_TODO_ID } from '../../../shared/todoHub'
import { missingContext, MissingContextKind } from '../../agent/session-context'
import { agentTabOf, readTodoHub, taskChildren } from '../../todo-hub/todo-hub'
import { listForAgent } from '../../todo-hub/agent-children'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { addArtifact, addLinkArtifact } from '../repositories/artifacts'
import { getSessionContext } from '../repositories/session-context'
import { getSettings } from '../repositories/settings'
import { addTaskCommit, CommitSource } from '../repositories/task-commits'
import { appendToolCall, updateToolCall } from '../repositories/tool-events'
import { getUiState, listUiState, setUiState } from '../repositories/ui-state'
import { addWatcher, listWatchers } from '../repositories/watchers'
import { MIGRATIONS } from '.'
import { threeTabsMigration } from './0064-three-tabs'

const PR = 'https://github.com/acme/api/pull/511'

/** A database as an app from before `version` left it, with a workspace and a task. */
function databaseBefore(version: number): Database {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < version),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', 'Ship the rate-limit fixes', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1,
      NULL, 'session-from-before')`,
  ).run()
  return db
}

/** A call of the task's agent, finished, as the tool log keeps it. */
function call(db: Database, toolUseId: string, name: string, input: Record<string, unknown>, output: string): void {
  appendToolCall(db, { taskId: 't', turn: 1, name, input, toolUseId, parentToolUseId: null }, 3_000)
  updateToolCall(db, { taskId: 't', toolUseId, state: ToolCallState.Done, output }, 3_100)
}

/**
 * What a task had made before the phase (P16), written into a database from before its first migration (0059): two
 * todos, a file and a link declared as artifacts, a subagent, a commit and a watcher, with its session started and
 * recorded as told everything the prompt said then. Nothing says which todo any of it belongs to: nothing could.
 */
function taskFromBeforeThePhase(): Database {
  const db = databaseBefore(59)
  call(db, 'toolu_create_1', 'TaskCreate', { subject: 'Return Retry-After on 429s' }, 'Task #1 created successfully: Return Retry-After on 429s')
  call(db, 'toolu_create_2', 'TaskCreate', { subject: 'Document the rate limits' }, 'Task #2 created successfully: Document the rate limits')
  call(db, 'toolu_fix', 'Agent', { description: 'Fix the 429 handler', prompt: 'Fix it.' }, 'Fixed and committed.')
  addArtifact(db, { taskId: 't', path: 'docs/rate-limits.md', title: 'Rate limits' }, 4_000)
  addLinkArtifact(db, { taskId: 't', url: PR, title: 'Return Retry-After on 429s' }, 4_100)
  addTaskCommit(db, {
    taskId: 't',
    gitDir: '/code/acme-api/.git',
    repoPath: '/code/acme-api',
    hash: 'a'.repeat(40),
    subject: 'Return Retry-After on 429s',
    branch: 'main',
    committedAt: 4_200,
    additions: 12,
    deletions: 3,
    filesChanged: 2,
    parents: 1,
    toolUseId: null,
    source: CommitSource.Printed,
  })
  addWatcher(
    db,
    {
      taskId: 't',
      kind: WatcherKind.Monitor,
      toolUseId: 'toolu_watch',
      parentToolUseId: null,
      sdkId: 'bm4k8w2',
      label: 'CI checks on PR #511',
      detail: 'gh pr checks 511 --watch',
      cron: null,
      schedule: null,
      recurring: false,
      state: WatcherState.Running,
      nextDueAt: null,
      expiresAt: null,
    },
    4_300,
  )
  db.prepare(
    "INSERT INTO session_context (task_id, instructions, instruction_updates, handoff_at, sandbox) VALUES ('t', 1, 2, NULL, 0)",
  ).run()
  // What the tabs that are going had stored.
  db.prepare("INSERT INTO artifact_groups VALUES ('t', 'older', 1)").run()
  db.prepare("INSERT INTO artifact_filters VALUES ('t', 'links')").run()
  setUiState(db, { key: UiStateKey.RightPanelTab, value: 'artifacts' })
  setUiState(db, { key: UiStateKey.RightPanelTabs, value: '{"w":"changes","w2":"files","w3":"subagents"}' })
  return db
}

const tables = (db: Database): unknown[] =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'artifact%' ORDER BY name").pluck().all()

it('is migration 64, after every earlier one', () => {
  expect(threeTabsMigration.version).toBe(64)
  expect(MIGRATIONS.indexOf(threeTabsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 64).length)
})

describe('a database from before the phase (pre-0059), migrated', () => {
  it('shows everything the task produced under "Not under a todo", and none of it under a todo', () => {
    const db = taskFromBeforeThePhase()

    migrate(db, MIGRATIONS)

    const hub = readTodoHub(db, 't')
    expect(hub.filings).toEqual([])
    expect(hub.panels).toEqual([])
    expect(hub.children.todos.map(({ todoId, children }) => [todoId, children])).toEqual([
      ['1', []],
      ['2', []],
    ])
    expect(hub.children.unfiled.todoId).toBe(UNFILED_TODO_ID)
    // Each with no filing: nothing said where it belongs.
    expect(hub.children.unfiled.children.map(({ kind, source }) => [kind, source]).sort()).toEqual([
      [ChildKind.Commit, null],
      [ChildKind.File, null],
      [ChildKind.Link, null],
    ])
    expect(hub.children.unfiled.children.map(({ key }) => key)).toEqual(
      expect.arrayContaining(['docs/rate-limits.md', PR]) as unknown,
    )
    db.close()
  })

  it('leaves its subagent on no todo (no "Working on" line) and its watcher with its agent, on Main’s tab', () => {
    const db = taskFromBeforeThePhase()

    migrate(db, MIGRATIONS)

    expect(subagentTodo(taskChildren(db, 't'), 'toolu_fix')).toBeNull()
    expect(listWatchers(db, 't').map(({ label, parentToolUseId, state }) => [label, parentToolUseId, state])).toEqual([
      ['CI checks on PR #511', null, WatcherState.Running],
    ])
    expect(agentTabOf(db, 't')).toBeNull()
    db.close()
  })

  it('lets its agent sort it: everything it made is listed with an id to file it by, the subagent among them', () => {
    const db = taskFromBeforeThePhase()
    migrate(db, MIGRATIONS)

    const listed = listForAgent(db, 't')

    expect(listed.map(({ todo, children }) => [todo?.id ?? null, children.map(({ id, kind }) => `${id} ${kind}`)])).toEqual([
      ['1', []],
      ['2', []],
      [null, ['c1 file', 'c2 link', 'c3 subagent', 'c4 commit']],
    ])
    db.close()
  })

  it('has its session owed the hub’s instructions, once: nothing recorded says it was told', () => {
    const db = taskFromBeforeThePhase()

    migrate(db, MIGRATIONS)

    const recorded = getSessionContext(db, 't')
    expect(recorded).toEqual({ instructions: true, instructionUpdates: 2, handoffAt: null, sandbox: false, todoHub: false })
    expect(
      missingContext({ recorded, startedElsewhere: false, handoff: null, prompt: '', sandboxed: false }),
    ).toEqual([{ kind: MissingContextKind.TodoHub }])
    db.close()
  })

  it('drops what the Artifacts tab remembered, and opens every workspace left on a removed tab on Agents', () => {
    const db = taskFromBeforeThePhase()
    expect(tables(db)).toEqual(['artifact_filters', 'artifact_groups', 'artifacts'])

    migrate(db, MIGRATIONS)

    expect(tables(db)).toEqual(['artifacts'])
    // The tab every workspace once shared is forgotten; of each workspace's own, only one the panel still has is kept.
    expect(getUiState(db, UiStateKey.RightPanelTab)).toBeUndefined()
    expect(getUiState(db, UiStateKey.RightPanelTabs)).toBe('{"w2":"files"}')
    expect(db.pragma('foreign_key_check')).toEqual([])
    db.close()
  })
})

describe('a database from while the phase was built behind its switch, migrated', () => {
  it.each(['true', 'false', '"on"'])('drops the switch stored as %s: the hub is on whatever it said', (stored) => {
    const db = databaseBefore(64)
    db.prepare("INSERT INTO settings (key, value) VALUES ('todoHubEnabled', ?)").run(stored)
    db.prepare("INSERT INTO settings (key, value) VALUES ('notifications', 'false')").run()

    migrate(db, MIGRATIONS)

    expect(db.prepare('SELECT key FROM settings').pluck().all()).toEqual(['notifications'])
    expect(getSettings(db)).toEqual({ ...DEFAULT_SETTINGS, notifications: false })
    expect(readTodoHub(db, 't')).toMatchObject({ filings: [] })
    db.close()
  })

  it('keeps a tab the panel still has, and what a todo’s panel and an agent’s tab remembered', () => {
    const db = databaseBefore(64)
    setUiState(db, { key: UiStateKey.RightPanelTab, value: 'todos' })
    setUiState(db, { key: UiStateKey.RightPanelTabs, value: '{"w":"agents","w2":"tool-calls","w3":"todos"}' })
    db.prepare("INSERT INTO todo_panels (task_id, todo_id, open, filter) VALUES ('t', '1', 1, 'commit')").run()
    db.prepare("INSERT INTO agent_tabs (task_id, agent_id) VALUES ('t', 'toolu_fix')").run()

    migrate(db, MIGRATIONS)

    expect(getUiState(db, UiStateKey.RightPanelTab)).toBe('todos')
    expect(JSON.parse(getUiState(db, UiStateKey.RightPanelTabs) ?? '')).toEqual({ w: 'agents', w3: 'todos' })
    expect(readTodoHub(db, 't').panels).toEqual([{ taskId: 't', todoId: '1', open: true, filter: ChildFilter.Commits }])
    expect(agentTabOf(db, 't')).toBe('toolu_fix')
    db.close()
  })

  it.each(['not json', '[]', '"agents"', '7'])('leaves each workspace’s tabs alone when what’s stored is %s, not an object', (stored) => {
    const db = databaseBefore(64)
    setUiState(db, { key: UiStateKey.RightPanelTabs, value: stored })

    migrate(db, MIGRATIONS)

    expect(getUiState(db, UiStateKey.RightPanelTabs)).toBe(stored)
    db.close()
  })

  it('leaves an empty object when every workspace was on a removed tab, and applies to a database with nothing stored', () => {
    const db = databaseBefore(64)
    setUiState(db, { key: UiStateKey.RightPanelTabs, value: '{"w":"watchers","w2":"artifacts"}' })

    migrate(db, MIGRATIONS)

    expect(getUiState(db, UiStateKey.RightPanelTabs)).toBe('{}')
    const fresh = databaseBefore(64)
    migrate(fresh, MIGRATIONS)
    expect(listUiState(fresh)).toEqual([])
    fresh.close()
    db.close()
  })
})
