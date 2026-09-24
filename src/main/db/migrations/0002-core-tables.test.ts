import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRole } from '../../../shared/domain'
import { appendMessage, listMessages } from '../repositories/messages'
import { getTask } from '../repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../repositories/test-database'
import { appendNarration, listToolEvents } from '../repositories/tool-events'
import { MIGRATIONS } from '.'
import { coreTablesMigration } from './0002-core-tables'

let test: TestDatabase

beforeEach(() => {
  test = openTestDatabase()
})

afterEach(() => {
  test.close()
})

describe('the core tables migration', () => {
  it('is migration 2', () => {
    expect(MIGRATIONS[1]).toBe(coreTablesMigration)
  })

  it('creates the tables and the indexes for the common queries', () => {
    const names = test.db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name")
    expect(names.pluck().all()).toEqual(
      expect.arrayContaining([
        'workspaces',
        'tasks',
        'tasks_by_workspace',
        'messages',
        'sqlite_autoindex_messages_2', // UNIQUE (task_id, seq)
        'tool_events',
        'sqlite_autoindex_tool_events_2', // UNIQUE (task_id, seq)
        'ui_state',
      ]),
    )
  })

  it("deletes a task's messages and tool events with it, and a workspace's tasks with it", () => {
    const workspace = sampleWorkspace(test.db)
    const task = sampleTask(test.db, workspace.id)
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 })
    appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Checking.' })

    test.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id)

    expect(getTask(test.db, task.id)).toBeUndefined()
    expect(listMessages(test.db, task.id)).toEqual([])
    expect(listToolEvents(test.db, task.id)).toEqual([])
  })

  it('checks the task enum columns and that only done tasks have a done time', () => {
    const task = sampleTask(test.db, sampleWorkspace(test.db).id)
    const update = (set: string) => () => test.db.prepare(`UPDATE tasks SET ${set} WHERE id = ?`).run(task.id)

    expect(update("state = 'paused'")).toThrow('CHECK constraint failed')
    expect(update("effort = 'xhigh'")).toThrow('CHECK constraint failed')
    expect(update('pinned = 2')).toThrow('CHECK constraint failed')
    expect(update("state = 'done'")).toThrow('CHECK constraint failed')
    expect(update('done_at = 1')).toThrow('CHECK constraint failed')
    expect(update("state = 'done', done_at = 1")).not.toThrow()
  })
})
