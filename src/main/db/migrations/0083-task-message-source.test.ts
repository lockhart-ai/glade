import { expect, it } from 'vitest'
import { MessageRole, MessageSource, TaskActivity } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { appendMessage, listMessages } from '../repositories/messages'
import { appendQueuedMessage, listQueuedMessages } from '../repositories/queued-messages'
import { searchTaskIds } from '../repositories/search'
import { MIGRATIONS } from '.'
import { taskMessageSourceMigration } from './0083-task-message-source'

const EARLIER = MIGRATIONS.filter((migration) => migration.version < 83)

function setUp(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:')
  migrate(db, EARLIER)
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  return db
}

/** A row in the pre-83 schema, whose tables have no `sender_task_id`: what a database at version 82 holds. */
function insertBefore(db: ReturnType<typeof openDatabase>, seq: number, body: string, source: string | null): void {
  const id = `m${String(seq)}`
  db.prepare(
    `INSERT INTO messages (id, task_id, seq, role, body, turn, created_at, source) VALUES (?, 't', ?, 'user', ?, 1, 2, ?)`,
  ).run(id, seq, body, source)
  db.prepare(
    `INSERT INTO queued_messages (id, task_id, seq, body, created_at, source) VALUES (?, 't', ?, ?, 3, ?)`,
  ).run(`${id}-queued`, seq, body, source)
}

it('is migration 83, after every earlier one', () => {
  expect(taskMessageSourceMigration.version).toBe(83)
  expect(taskMessageSourceMigration.rebuildsReferencedTable).toBe(true)
  expect(MIGRATIONS.indexOf(taskMessageSourceMigration)).toBe(MIGRATIONS.filter((m) => m.version < 83).length)
})

it('keeps every existing message and queued message with its source, and the new sender is null', () => {
  const db = setUp()
  insertBefore(db, 1, 'Is anyone restarting Docker?', 'broadcast')
  insertBefore(db, 2, 'PR #1 closed', 'github')
  insertBefore(db, 3, 'A message of your own.', null)

  migrate(db, MIGRATIONS)

  expect(listMessages(db, 't')).toMatchObject([
    { id: 'm1', source: MessageSource.Broadcast, senderTaskId: null },
    { id: 'm2', source: MessageSource.Github, senderTaskId: null },
    { id: 'm3', source: null, senderTaskId: null },
  ])
  expect(listQueuedMessages(db, 't')).toMatchObject([
    { id: 'm1-queued', source: MessageSource.Broadcast, senderTaskId: null },
    { id: 'm2-queued', source: MessageSource.Github, senderTaskId: null },
    { id: 'm3-queued', source: null, senderTaskId: null },
  ])

  const sent = appendMessage(db, { taskId: 't', role: MessageRole.User, body: 'new', turn: 2, source: null })
  const task = appendMessage(db, {
    taskId: 't',
    role: MessageRole.User,
    body: 'The login race is fixed in PR #48.',
    turn: 2,
    source: MessageSource.Task,
    senderTaskId: 'other',
  })
  const queuedTask = appendQueuedMessage(db, {
    taskId: 't',
    body: 'Bounced the test runner.',
    source: MessageSource.Task,
    senderTaskId: 'other',
  })
  expect(sent.source).toBeNull()
  expect(task).toMatchObject({ source: MessageSource.Task, senderTaskId: 'other' })
  expect(queuedTask).toMatchObject({ source: MessageSource.Task, senderTaskId: 'other' })
  db.close()
})

it('refuses a source outside the new CHECK', () => {
  const db = setUp()
  insertBefore(db, 1, 'Is anyone restarting Docker?', 'broadcast')
  migrate(db, MIGRATIONS)
  expect(() => db.prepare("UPDATE messages SET source = 'tweet' WHERE id = 'm1'").run()).toThrow()
  expect(() => db.prepare("UPDATE queued_messages SET source = 'tweet' WHERE task_id = 't'").run()).toThrow()
  db.close()
})

it('keeps search finding messages: one carried through and one appended after the rebuild', () => {
  const db = setUp()
  insertBefore(db, 1, 'The login race is fixed in PR #48.', null)
  migrate(db, MIGRATIONS)
  // A message appended after the rebuild is indexed by the trigger recreated with the new table.
  appendMessage(db, {
    taskId: 't',
    role: MessageRole.User,
    body: 'Rebasing the flaky chat cases now.',
    turn: 2,
    source: null,
  })
  expect(searchTaskIds(db, 'w', 'rebasing flaky')).toEqual(['t'])
  // And the message carried through the rebuild is still found.
  expect(searchTaskIds(db, 'w', 'login race')).toEqual(['t'])
  db.close()
})

it('keeps the activity of a task with messages through the rebuild', () => {
  const db = setUp()
  insertBefore(db, 1, 'A message.', null)
  migrate(db, MIGRATIONS)
  const activity: unknown = db.prepare("SELECT activity FROM tasks WHERE id = 't'").pluck().get()
  expect(activity).toBe(TaskActivity.Waiting)
  db.close()
})
