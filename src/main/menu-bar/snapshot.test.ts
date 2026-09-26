import { afterEach, beforeEach, expect, it } from 'vitest'
import { DividerKind, MessageRole, QuestionKind, TaskActivity, TaskState } from '../../shared/domain'
import { EMPTY_MENU_BAR_SNAPSHOT, NeedsYouReason, RECENT_NOTIFICATIONS_SHOWN } from '../../shared/menuBar'
import { appendMessage } from '../db/repositories/messages'
import { recordNotification } from '../db/repositories/notifications'
import { appendPermissionRequest } from '../db/repositories/permission-requests'
import { appendQuestionSet } from '../db/repositories/question-sets'
import { setTaskTodos, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendDivider } from '../db/repositories/tool-events'
import { createWorkspace } from '../db/repositories/workspaces'
import { readMenuBarSnapshot } from './snapshot'

let test: TestDatabase

beforeEach(() => {
  test = openTestDatabase()
})

afterEach(() => {
  test.close()
})

/** A task that has run, with a title, as `patch` has it, updated at `at`. */
function ranTask(workspaceId: string, title: string, patch: Parameters<typeof updateTask>[2], at: number): string {
  const task = sampleTask(test.db, workspaceId)
  updateTask(test.db, task.id, { title, sessionId: `session-${title}`, ...patch }, at)
  return task.id
}

it('is empty with no workspaces, and with only idle, new and done tasks', () => {
  expect(readMenuBarSnapshot(test.db)).toEqual(EMPTY_MENU_BAR_SNAPSHOT)
  const workspace = sampleWorkspace(test.db)
  sampleTask(test.db, workspace.id)
  ranTask(workspace.id, 'Shipped', { state: TaskState.Done }, 3_000)
  expect(readMenuBarSnapshot(test.db)).toEqual(EMPTY_MENU_BAR_SNAPSHOT)
})

it('reads every workspace’s tasks that need you, with why, from their questions and permission cards', () => {
  const acme = sampleWorkspace(test.db)
  const billing = createWorkspace(test.db, { name: 'Billing', rootPath: '/code/billing' }, 1_500)
  const asking = ranTask(acme.id, 'Add rate limiting', { activity: TaskActivity.Working }, 3_000)
  appendQuestionSet(test.db, {
    taskId: asking,
    turn: 1,
    questions: [{ kind: QuestionKind.Pills, prompt: 'Which limit?', options: ['60', '120'] }],
  })
  const permission = ranTask(billing.id, 'Migrate the webhooks', { activity: TaskActivity.Working }, 4_000)
  appendPermissionRequest(test.db, {
    taskId: permission,
    turn: 1,
    toolUseId: 'bash-1',
    agentId: null,
    toolName: 'Bash',
    input: { command: 'npm test' },
    title: null,
    displayName: 'Bash',
    description: null,
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
  })
  const failed = ranTask(billing.id, 'Bump the SDK', { activity: TaskActivity.Error }, 5_000)
  const replied = ranTask(acme.id, 'Clean up the fixtures', {}, 2_000)

  const snapshot = readMenuBarSnapshot(test.db)
  expect(snapshot.needsYou.map(({ taskId, workspaceName, reason }) => [taskId, workspaceName, reason])).toEqual([
    [failed, 'Billing', NeedsYouReason.Error],
    [permission, 'Billing', NeedsYouReason.Permission],
    [asking, 'Acme API', NeedsYouReason.Asking],
    [replied, 'Acme API', NeedsYouReason.Reply],
  ])
  expect(snapshot.working).toEqual([])
})

it('reads the working tasks with their todos and when their current turn started', () => {
  const workspace = sampleWorkspace(test.db)
  const task = ranTask(
    workspace.id,
    'Fix the date test',
    { activity: TaskActivity.Working, status: 'Running the tests' },
    9_000,
  )
  setTaskTodos(test.db, task, { done: 3, total: 7, doing: ['Run the tests'] })
  appendMessage(test.db, { taskId: task, role: MessageRole.User, body: 'Fix it', turn: 1 }, 4_000)
  appendMessage(test.db, { taskId: task, role: MessageRole.Agent, body: 'Fixed.', turn: 1 }, 5_000)
  appendMessage(test.db, { taskId: task, role: MessageRole.User, body: 'And the other one', turn: 2 }, 7_000)
  // A turn the agent started on its own has only its divider.
  const selfStarted = ranTask(workspace.id, 'Watch CI', { activity: TaskActivity.Working }, 9_000)
  appendDivider(test.db, { taskId: selfStarted, turn: 1, dividerKind: DividerKind.Turn }, 8_000)

  expect(readMenuBarSnapshot(test.db).working).toEqual([
    {
      taskId: task,
      title: 'Fix the date test',
      workspaceId: workspace.id,
      workspaceName: 'Acme API',
      status: 'Running the tests',
      todos: { done: 3, total: 7, doing: ['Run the tests'] },
      pause: null,
      startedAt: 7_000,
    },
    {
      taskId: selfStarted,
      title: 'Watch CI',
      workspaceId: workspace.id,
      workspaceName: 'Acme API',
      status: '',
      todos: null,
      pause: null,
      startedAt: 8_000,
    },
  ])
})

it('reads the latest notifications sent, newest first, as many as Recent shows', () => {
  const workspace = sampleWorkspace(test.db)
  const task = ranTask(workspace.id, 'Add rate limiting', {}, 2_000)
  for (let index = 1; index <= RECENT_NOTIFICATIONS_SHOWN + 2; index += 1) {
    recordNotification(test.db, { taskId: task, title: 'Add rate limiting', body: `Reply ${String(index)}` }, index)
  }
  const { recent } = readMenuBarSnapshot(test.db)
  expect(recent).toHaveLength(RECENT_NOTIFICATIONS_SHOWN)
  expect(recent[0]?.body).toBe(`Reply ${String(RECENT_NOTIFICATIONS_SHOWN + 2)}`)
})
