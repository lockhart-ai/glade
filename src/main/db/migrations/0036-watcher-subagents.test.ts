import type { Database } from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listWatchers } from '../repositories/watchers'
import { MIGRATIONS } from '.'
import { watcherSubagentsMigration } from './0036-watcher-subagents'

it('is migration 36', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 36)).toBe(watcherSubagentsMigration)
})

/** A database at the schema before this migration, with one task. */
function before(): Database {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 36),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  return db
}

let seq = 0

interface OldCall {
  readonly toolUseId: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  readonly output: string | null
  readonly parent: string | null
}

function insertCall(db: Database, call: OldCall): void {
  seq += 1
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_output, tool_state,
      tool_use_id, parent_tool_use_id)
    VALUES (?, 't', ?, 'tool_call', 1, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `e${String(seq)}`,
    seq,
    call.name,
    JSON.stringify(call.input),
    call.output,
    call.output === null ? 'running' : 'done',
    call.toolUseId,
    call.parent,
  )
}

function insertWatcher(db: Database, toolUseId: string, kind: string, label: string, state = 'finished'): void {
  db.prepare(
    `INSERT INTO watchers (id, task_id, kind, tool_use_id, label, detail, recurring, state, started_at)
    VALUES (?, 't', ?, ?, ?, '', 0, ?, 1)`,
  ).run(`w-${toolUseId}`, kind, toolUseId, label, state)
}

it("gives each watcher its call's subagent, and drops the foreground commands that were taken for watchers", () => {
  const db = before()
  const calls: readonly OldCall[] = [
    // The task's own background command, and a subagent's.
    {
      toolUseId: 'own',
      name: 'Bash',
      input: { command: 'npm run e2e', run_in_background: true },
      output: 'ID: b1',
      parent: null,
    },
    {
      toolUseId: 'sub',
      name: 'Bash',
      input: { command: 'npm test', run_in_background: true },
      output: 'ID: b2',
      parent: 'agent',
    },
    // A subagent's Monitor.
    { toolUseId: 'mon', name: 'Monitor', input: { command: 'tail -F ci.log' }, output: 'started', parent: 'agent' },
    // Foreground commands, the task's own and a subagent's, one still running when the app quit.
    { toolUseId: 'fg', name: 'Bash', input: { command: 'gh pr view 42' }, output: 'open', parent: null },
    {
      toolUseId: 'fgsub',
      name: 'Bash',
      input: { command: 'npm ci', run_in_background: false },
      output: 'ok',
      parent: 'agent',
    },
    { toolUseId: 'fgrun', name: 'Bash', input: { command: 'sleep 30' }, output: null, parent: 'agent' },
    // A foreground command the SDK moved to the background when it ran past its timeout: a real watcher.
    {
      toolUseId: 'moved',
      name: 'Bash',
      input: { command: 'gh pr checks 42 --watch' },
      output: 'Command did not complete within its 600s timeout and was moved to the background (ID: b3).',
      parent: 'agent',
    },
  ]
  for (const call of calls) insertCall(db, call)
  for (const { toolUseId, name } of calls) {
    insertWatcher(db, toolUseId, name === 'Monitor' ? 'monitor' : 'command', toolUseId, 'finished')
  }
  // A command whose call was never logged, still running: a relaunch stops it, as any.
  insertWatcher(db, 'unlogged', 'command', 'unlogged', 'running')

  migrate(db, MIGRATIONS)

  expect(listWatchers(db, 't').map(({ label, parentToolUseId }) => [label, parentToolUseId])).toEqual([
    ['own', null],
    ['sub', 'agent'],
    ['mon', 'agent'],
    ['moved', 'agent'],
    ['unlogged', null],
  ])
  db.close()
})
