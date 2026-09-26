import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../../shared/domain'
import { openAppDatabase } from '../database'
import { listRecentNotifications, NOTIFICATIONS_KEPT, recordNotification } from './notifications'
import { deleteTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

function send(body: string, at: number, taskId = task.id): void {
  recordNotification(test.db, { taskId, title: 'Add rate limiting', body }, at)
}

describe('recordNotification', () => {
  it('notes what was sent, and when, numbering it after the last', () => {
    expect(recordNotification(test.db, { taskId: task.id, title: 'Add rate limiting', body: 'Done.' }, 5_000)).toEqual({
      seq: 1,
      taskId: task.id,
      title: 'Add rate limiting',
      body: 'Done.',
      sentAt: 5_000,
    })
    expect(
      recordNotification(test.db, { taskId: task.id, title: 'Add rate limiting', body: 'Again.' }, 5_000)?.seq,
    ).toBe(2)
  })

  it('notes nothing for a task that is not there', () => {
    expect(recordNotification(test.db, { taskId: 'gone', title: 'Gone', body: 'Done.' })).toBeNull()
    expect(listRecentNotifications(test.db, 10)).toEqual([])
  })

  it('keeps only the latest, however many are sent', () => {
    for (let index = 1; index <= NOTIFICATIONS_KEPT + 7; index += 1) send(`Reply ${String(index)}`, index)
    const kept = listRecentNotifications(test.db, 100)
    expect(kept).toHaveLength(NOTIFICATIONS_KEPT)
    expect(kept[0]?.body).toBe(`Reply ${String(NOTIFICATIONS_KEPT + 7)}`)
    expect(kept.at(-1)?.body).toBe('Reply 8')
  })

  it('keeps as many as it is told to', () => {
    for (let index = 1; index <= 4; index += 1) {
      recordNotification(test.db, { taskId: task.id, title: 'T', body: String(index) }, index, 2)
    }
    expect(listRecentNotifications(test.db, 10).map(({ body }) => body)).toEqual(['4', '3'])
  })
})

describe('listRecentNotifications', () => {
  it('lists the newest first, in the order they were sent even when sent at the same time, up to the limit', () => {
    send('first', 1_000)
    send('second', 1_000)
    send('third', 900)
    expect(listRecentNotifications(test.db, 2).map(({ body }) => body)).toEqual(['third', 'second'])
    expect(listRecentNotifications(test.db, 5).map(({ body }) => body)).toEqual(['third', 'second', 'first'])
  })

  it("drops a deleted task's notifications and keeps the others", () => {
    const other = sampleTask(test.db, task.workspaceId)
    send('kept', 1, other.id)
    send('dropped', 2)
    deleteTask(test.db, task.id)
    expect(listRecentNotifications(test.db, 5).map(({ body }) => body)).toEqual(['kept'])
  })
})

it('keeps the notifications across a relaunch', () => {
  const folder = mkdtempSync(join(tmpdir(), 'glade-notifications-'))
  try {
    const first = openAppDatabase(folder)
    const sample = sampleTask(first.db, sampleWorkspace(first.db).id)
    recordNotification(first.db, { taskId: sample.id, title: 'Add rate limiting', body: 'Which limit?' }, 7_000)
    first.db.close()

    const again = openAppDatabase(folder)
    expect(listRecentNotifications(again.db, 5)).toEqual([
      { seq: 1, taskId: sample.id, title: 'Add rate limiting', body: 'Which limit?', sentAt: 7_000 },
    ])
    again.db.close()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
