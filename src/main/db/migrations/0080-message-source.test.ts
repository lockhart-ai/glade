import { expect, it } from 'vitest'
import { MessageRole, MessageSource } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { appendMessage, listMessages } from '../repositories/messages'
import { appendQueuedMessage, listQueuedMessages } from '../repositories/queued-messages'
import { MIGRATIONS } from '.'
import { messageSourceMigration } from './0080-message-source'

it('is migration 80, after every earlier one', () => {
  expect(messageSourceMigration.version).toBe(80)
  expect(MIGRATIONS.indexOf(messageSourceMigration)).toBe(MIGRATIONS.filter((m) => m.version < 80).length)
})

it('carries broadcast = 1 forward as source = broadcast, and broadcast = 0 as no source', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 80),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO messages (id, task_id, seq, role, body, turn, created_at, broadcast)
    VALUES ('m1', 't', 1, 'user', 'Fix the flaky login test.', 1, 2, 0),
           ('m2', 't', 2, 'user', 'Is anyone restarting Docker?', 2, 3, 1)`,
  ).run()
  db.prepare(
    `INSERT INTO queued_messages (id, task_id, seq, body, created_at, broadcast)
    VALUES ('q1', 't', 1, 'Keep the filenames.', 4, 0), ('q2', 't', 2, 'Is anyone restarting Docker?', 5, 1)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listMessages(db, 't')).toMatchObject([
    { id: 'm1', source: null },
    { id: 'm2', source: MessageSource.Broadcast },
  ])
  expect(listQueuedMessages(db, 't')).toMatchObject([
    { id: 'q1', source: null },
    { id: 'q2', source: MessageSource.Broadcast },
  ])
  expect(() => db.prepare('SELECT broadcast FROM messages').run()).toThrow()
  expect(() => db.prepare('SELECT broadcast FROM queued_messages').run()).toThrow()

  const sent = appendMessage(db, { taskId: 't', role: MessageRole.User, body: 'new', turn: 3, source: null })
  const github = appendQueuedMessage(db, { taskId: 't', body: 'PR #1 closed', source: MessageSource.Github })
  expect(sent.source).toBeNull()
  expect(github.source).toBe(MessageSource.Github)
  db.close()
})
