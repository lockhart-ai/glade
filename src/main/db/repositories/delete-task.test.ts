import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DividerKind, MessageRole, QuestionKind, type Task, type Workspace } from '../../../shared/domain'
import { GIF, PNG } from '../../../shared/test-images'
import { addArtifact } from './artifacts'
import { setExternalId, setHandoff } from './backfills'
import { appendMessage } from './messages'
import { setOpenFiles } from './open-files'
import { appendPermissionRequest } from './permission-requests'
import { addTaskPermissionRule } from './task-permission-rules'
import { appendQuestionSet } from './question-sets'
import { appendQueuedMessage } from './queued-messages'
import { deleteTask, getTask, listTasks } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { appendDivider, appendNarration, appendToolCall } from './tool-events'
import { setWorkspaceSelection } from './workspace-selections'
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
  appendMessage(db, { taskId, role: MessageRole.User, body: 'Add rate limiting', turn: 1, images: [PNG] })
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
  appendQueuedMessage(db, { taskId, body: 'Also cover /search', images: [GIF] })
  setOpenFiles(db, { taskId, paths: ['api/views.py'], activePath: 'api/views.py' })
  addArtifact(db, { taskId, path: 'docs/rate-limits.md', title: 'Rate limits' })
  setWorkspaceSelection(db, task.workspaceId, taskId)
  appendQuestionSet(db, {
    taskId,
    turn: 1,
    questions: [{ kind: QuestionKind.Pills, prompt: 'Which limit?', options: ['120', '60'] }],
  })
  appendPermissionRequest(db, {
    taskId,
    turn: 1,
    toolUseId: `bash-${taskId}`,
    agentId: null,
    toolName: 'Bash',
    input: { command: 'npm test' },
    title: null,
    displayName: 'Bash',
    description: 'Run the tests',
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
  })
  addTaskPermissionRule(db, { taskId, rule: { toolName: 'Bash', ruleContent: 'npm test *' } })
  setHandoff(db, taskId, '## Where it got to')
  setExternalId(db, taskId, `notes/${taskId}`)
}

/** The tables `fillTask` writes to. A new table that belongs to a task fails the test below until it's added here. */
const FILLED_TABLES = [
  'artifacts',
  // The images pasted into its messages, sent and queued.
  'images',
  'messages',
  'open_files',
  'permission_requests',
  'question_sets',
  'queued_messages',
  // The search index's rows for its fields and messages, which a new task and `fillTask`'s message make.
  'search_documents',
  // Its handoff note and the caller's own id for it, from a backfill through the control API.
  'task_backfills',
  // The permission rules granted it with Allow for this task.
  'task_permission_rules',
  'tool_events',
  'workspace_selections',
]

describe('deleteTask', () => {
  it('knows every table that belongs to a task', () => {
    expect(taskTables(test.db)).toEqual(FILLED_TABLES)
  })

  it('leaves no row in any table that belongs to the task, and every other task as it was', () => {
    // In two workspaces, as a workspace has one selected task.
    const other = sampleWorkspace(test.db, '/code/acme-web')
    const doomed = sampleTask(test.db, workspace.id)
    const kept = sampleTask(test.db, other.id)
    fillTask(test.db, doomed)
    fillTask(test.db, kept)
    for (const table of FILLED_TABLES) expect(rowsOf(test.db, table, doomed.id), table).toBeGreaterThan(0)

    expect(deleteTask(test.db, doomed.id)).toBe(true)

    expect(getTask(test.db, doomed.id)).toBeUndefined()
    for (const table of taskTables(test.db)) {
      expect(rowsOf(test.db, table, doomed.id), table).toBe(0)
      expect(rowsOf(test.db, table, kept.id), table).toBeGreaterThan(0)
    }
    expect(listTasks(test.db, workspace.id)).toEqual([])
    expect(listTasks(test.db, other.id).map(({ id }) => id)).toEqual([kept.id])
    expect(getWorkspace(test.db, workspace.id)).toEqual(workspace)
  })

  it('answers false for a task that does not exist', () => {
    expect(deleteTask(test.db, 'missing')).toBe(false)
  })
})
