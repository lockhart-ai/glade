import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentErrorKind, Effort, PauseReason, TaskActivity, TaskState } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listMessages } from '../repositories/messages'
import { listQueuedMessages } from '../repositories/queued-messages'
import { getTask, updateTask } from '../repositories/tasks'
import { listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { taskPauseMigration } from './0010-task-pause'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 10, and rebuilds the tasks table with foreign keys off', () => {
  expect(MIGRATIONS[9]).toBe(taskPauseMigration)
  expect(taskPauseMigration.rebuildsReferencedTable).toBe(true)
})

it('keeps every task and what references it, and lets a task pause', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 9))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id, status_updated_at, context_used_tokens, context_window_tokens, error,
      retrying)
    VALUES ('t', 'w', 'Move uploads', 'Move them to S3.', 'Copying.', 'active', 'error', 1, 0, 'claude-sample-1', 'high',
      1, 2, NULL, 'session-1', 2, 1200, 200000,
      '{"kind":"transient","source":"api","status":529,"code":"overloaded","details":"x","retries":3,"retryingMs":10}',
      NULL)`,
  ).run()
  db.prepare(
    "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES ('m', 't', 1, 'user', 'Go.', 1, 3)",
  ).run()
  db.prepare(
    "INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, text) VALUES ('n', 't', 1, 'narration', 1, 4, 'Looking.')",
  ).run()
  db.prepare("INSERT INTO queued_messages (id, task_id, seq, body, created_at) VALUES ('q', 't', 1, 'Also.', 5)").run()

  migrate(db, MIGRATIONS)

  expect(getTask(db, 't')).toEqual({
    id: 't',
    workspaceId: 'w',
    title: 'Move uploads',
    objective: 'Move them to S3.',
    status: 'Copying.',
    statusUpdatedAt: 2,
    state: TaskState.Active,
    activity: TaskActivity.Error,
    pinned: true,
    unread: false,
    model: 'claude-sample-1',
    effort: Effort.High,
    createdAt: 1,
    updatedAt: 2,
    doneAt: null,
    sessionId: 'session-1',
    contextUsedTokens: 1200,
    contextWindowTokens: 200_000,
    error: expect.objectContaining({ kind: AgentErrorKind.Transient, retries: 3 }) as unknown,
    retrying: null,
    pause: null,
    asking: false,
  })
  expect(listMessages(db, 't')).toHaveLength(1)
  expect(listToolEvents(db, 't')).toHaveLength(1)
  expect(listQueuedMessages(db, 't')).toHaveLength(1)
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

  const pause = { reason: PauseReason.Offline, since: 6, resumesAt: 7, checks: 0, details: 'Connection error.' }
  expect(updateTask(db, 't', { activity: TaskActivity.Paused, pause })).toMatchObject({ pause })
  expect(() => db.prepare("UPDATE tasks SET pause = '[1]' WHERE id = 't'").run()).toThrow(/CHECK/)
  expect(() => db.prepare("UPDATE tasks SET activity = 'napping' WHERE id = 't'").run()).toThrow(/CHECK/)
  // The references still hold: deleting the task deletes what it owns.
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(listMessages(db, 't')).toHaveLength(0)
  db.close()
})
