import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRole, type Task } from '../../../shared/domain'
import { appendMessage, listMessages } from './messages'
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

describe('appendMessage', () => {
  it('stores a message with a new UUID', () => {
    const message = appendMessage(
      test.db,
      { taskId: task.id, role: MessageRole.User, body: 'Why is **the date test** flaky?', turn: 1 },
      3_000,
    )

    expect(message).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      taskId: task.id,
      role: MessageRole.User,
      body: 'Why is **the date test** flaky?',
      turn: 1,
      createdAt: 3_000,
    })
    expect(listMessages(test.db, task.id)).toEqual([message])
  })

  it('defaults the time to now', () => {
    const before = Date.now()
    const message = appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Fixed.', turn: 1 })
    expect(message.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('refuses a message for an unknown task, or a bad role', () => {
    expect(() => appendMessage(test.db, { taskId: 'missing', role: MessageRole.User, body: 'Hi', turn: 1 })).toThrow(
      'FOREIGN KEY constraint failed',
    )
    expect(() =>
      test.db
        .prepare(
          "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES ('m', ?, 1, 'system', '', 1, 0)",
        )
        .run(task.id),
    ).toThrow('CHECK constraint failed')
  })
})

describe('listMessages', () => {
  it("lists only this task's messages, in the order they were appended, even when times tie", () => {
    const other = sampleTask(test.db, task.workspaceId)
    const question = appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Q', turn: 1 }, 3_000)
    appendMessage(test.db, { taskId: other.id, role: MessageRole.User, body: 'Elsewhere', turn: 1 }, 3_000)
    const answer = appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'A', turn: 1 }, 3_000)
    const followUp = appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Q2', turn: 2 }, 3_000)

    expect(listMessages(test.db, task.id)).toEqual([question, answer, followUp])
  })

  it('rejects a row with an unknown role', () => {
    const message = appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 })
    test.db.pragma('ignore_check_constraints = ON')
    test.db.prepare("UPDATE messages SET role = 'system' WHERE id = ?").run(message.id)

    expect(() => listMessages(test.db, task.id)).toThrow('messages.role: expected one of user, agent, got "system"')
  })
})
