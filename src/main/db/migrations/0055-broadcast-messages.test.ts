import { expect, it } from 'vitest'
import { MessageRole } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { appendMessage, listMessages } from '../repositories/messages'
import { appendQueuedMessage, listQueuedMessages } from '../repositories/queued-messages'
import { MIGRATIONS } from '.'
import { broadcastMessagesMigration } from './0055-broadcast-messages'

it('is migration 55, after every earlier one', () => {
  expect(broadcastMessagesMigration.version).toBe(55)
  expect(MIGRATIONS.indexOf(broadcastMessagesMigration)).toBe(MIGRATIONS.filter((m) => m.version < 55).length)
})

it('leaves every message sent or queued before it as one to its own task, and marks broadcasts from then on', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 55),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    `INSERT INTO messages (id, task_id, seq, role, body, turn, created_at)
    VALUES ('m', 't', 1, 'user', 'Fix the flaky login test.', 1, 2)`,
  ).run()
  db.prepare(
    "INSERT INTO queued_messages (id, task_id, seq, body, created_at) VALUES ('q', 't', 1, 'Keep the filenames.', 3)",
  ).run()

  migrate(db, MIGRATIONS)

  expect(listMessages(db, 't')).toMatchObject([{ id: 'm', body: 'Fix the flaky login test.', broadcast: false }])
  expect(listQueuedMessages(db, 't')).toMatchObject([{ id: 'q', body: 'Keep the filenames.', broadcast: false }])

  const text = 'Is anyone restarting Docker?'
  const sent = appendMessage(db, { taskId: 't', role: MessageRole.User, body: text, turn: 2, broadcast: true })
  const queued = appendQueuedMessage(db, { taskId: 't', body: text, broadcast: true })
  expect(listMessages(db, 't').at(-1)).toEqual(sent)
  expect(listQueuedMessages(db, 't').at(-1)).toEqual(queued)
  expect([sent.broadcast, queued.broadcast]).toEqual([true, true])
  db.close()
})
