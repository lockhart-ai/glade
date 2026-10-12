// Test helpers: a migrated database in a temporary folder, and made-up sample rows.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { Effort, TodoState, ToolCallState, type Task, type Workspace } from '../../../shared/domain'
import { openAppDatabase } from '../database'
import { putTodos, seedTodoCounterAtLeast } from './glade-todos'
import { createTask } from './tasks'
import { appendToolCall, updateToolCall } from './tool-events'
import { createWorkspace } from './workspaces'

export interface TestDatabase {
  readonly db: Database
  /** Closes the database and deletes its folder. */
  close(): void
}

/** Opens a fresh app database, migrated to the latest schema, in a new temporary folder. */
export function openTestDatabase(): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'glade-repo-'))
  const { db } = openAppDatabase(dir)
  return {
    db,
    close() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function sampleWorkspace(db: Database, rootPath = '/code/acme-api'): Workspace {
  return createWorkspace(db, { name: 'Acme API', rootPath }, 1_000)
}

export function sampleTask(db: Database, workspaceId: string, now = 2_000): Task {
  return createTask(db, { workspaceId, model: 'claude-sample-1', effort: Effort.Medium }, now)
}

/** Seed an older schema without using the current task repository's columns. Migration tests name its id only. */
export interface LegacySampleTask {
  readonly id: string
}

export function sampleLegacyTask(db: Database, workspaceId: string): LegacySampleTask {
  const id = 'legacy-task'
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at)
    VALUES (?, ?, '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1000, 1000)`,
  ).run(id, workspaceId)
  return { id }
}

/**
 * A todo in a task's list (#609), by its own id, which is what a child is filed under: a row of Glade's own `todos`
 * table, with the task's counter raised past it so a later `create_todo` never reuses it. Also logs a `TaskCreate`
 * call with the same id and subject, as a task migrated from before #609 would still show in its tool log, for a
 * test that reads the log itself rather than the Todos tab.
 */
export function sampleTodo(
  db: Database,
  taskId: string,
  id = '1',
  subject = 'Draft the release notes',
  at = 3_000,
): void {
  const toolUseId = `toolu_create_${id}`
  appendToolCall(db, { taskId, turn: 1, name: 'TaskCreate', input: { subject }, toolUseId, parentToolUseId: null }, at)
  const output = `Task #${id} created successfully: ${subject}`
  updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Done, output }, at)
  putTodos(db, taskId, [{ id, text: subject, note: null, state: TodoState.Todo, completedAt: null }], at)
  seedTodoCounterAtLeast(db, taskId, Number(id) + 1)
}
