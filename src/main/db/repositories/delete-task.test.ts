import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DividerKind, MessageRole, QuestionKind, type Task, type Workspace } from '../../../shared/domain'
import { appendMessage } from './messages'
import { setOpenFiles } from './open-files'
import { appendQuestionSet } from './question-sets'
import { appendQueuedMessage } from './queued-messages'
import { deleteTask, getTask, listTasks } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { appendDivider, appendNarration, appendToolCall } from './tool-events'
import { getWorkspace } from './workspaces'

let test: TestDatabase
let workspace: Workspace

beforeEach(() => {
  test = openTestDatabase()
  workspace = sampleWorkspace(test.db)
})

afterEach(() => {
  test.close()
})

/** The tables whose rows belong to a task, found from the schema: those with a `task_id` column or a foreign key to it. */
function taskTables(db: Database): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[]
  return tables.filter((table) => {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[]
    const keys = db.pragma(`foreign_key_list(${table})`) as { table: string }[]
    return columns.some(({ name }) => name === 'task_id') || keys.some((key) => key.table === 'tasks')
  })
}

function rowsOf(db: Database, table: string, taskId: string): number {
  return db.prepare(`SELECT COUNT(*) FROM ${table} WHERE task_id = ?`).pluck().get(taskId) as number
}

/** Gives a task a row in every table that belongs to one. */
function fillTask(db: Database, task: Task): void {
  const taskId = task.id
  appendMessage(db, { taskId, role: MessageRole.User, body: 'Add rate limiting', turn: 1 })
  appendNarration(db, { taskId, turn: 1, text: 'Looking at the views.' })
  appendToolCall(db, {
    taskId,
    turn: 1,
    name: 'Read',
    input: { file_path: 'api/views.py' },
    toolUseId: `use-${taskId}`,
    parentToolUseId: null,
  })
  appendDivider(db, { taskId, turn: 1, dividerKind: DividerKind.Turn })
  appendQueuedMessage(db, { taskId, body: 'Also cover /search' })
  setOpenFiles(db, { taskId, paths: ['api/views.py'], activePath: 'api/views.py' })
  appendQuestionSet(db, {
    taskId,
    turn: 1,
    questions: [{ kind: QuestionKind.Pills, prompt: 'Which limit?', options: ['120', '60'] }],
  })
}

/** The tables `fillTask` writes to. A new table that belongs to a task fails the test below until it's added here. */
const FILLED_TABLES = [
  'messages',
  'open_files',
  'question_sets',
  'queued_messages',
  // The search index's rows for its fields and messages, which a new task and `fillTask`'s message make.
  'search_documents',
  'tool_events',
]

describe('deleteTask', () => {
  it('knows every table that belongs to a task', () => {
    expect(taskTables(test.db)).toEqual(FILLED_TABLES)
  })

  it('leaves no row in any table that belongs to the task, and every other task as it was', () => {
    const doomed = sampleTask(test.db, workspace.id)
    const kept = sampleTask(test.db, workspace.id)
    fillTask(test.db, doomed)
    fillTask(test.db, kept)
    for (const table of FILLED_TABLES) expect(rowsOf(test.db, table, doomed.id), table).toBeGreaterThan(0)

    expect(deleteTask(test.db, doomed.id)).toBe(true)

    expect(getTask(test.db, doomed.id)).toBeUndefined()
    for (const table of taskTables(test.db)) {
      expect(rowsOf(test.db, table, doomed.id), table).toBe(0)
      expect(rowsOf(test.db, table, kept.id), table).toBeGreaterThan(0)
    }
    expect(listTasks(test.db, workspace.id).map(({ id }) => id)).toEqual([kept.id])
    expect(getWorkspace(test.db, workspace.id)).toEqual(workspace)
  })

  it('answers false for a task that does not exist', () => {
    expect(deleteTask(test.db, 'missing')).toBe(false)
  })
})
