import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DividerKind, MessageRole, type Task } from '../../../shared/domain'
import { GIF, JPEG, PNG } from '../../../shared/test-images'
import { getImage, ImageOwnerKind, imagesOf } from './images'
import { appendMessage, firstUserMessageOfSession, lastTurn, listMessages, turnStartedAt } from './messages'
import { updateTask } from './tasks'
import { appendDivider, appendNarration } from './tool-events'
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
      summary: null,
      images: [],
    })
    expect(listMessages(test.db, task.id)).toEqual([message])
  })

  it("stores an agent reply's turn summary, with or without a duration", () => {
    const summary = { durationMs: 1_450_000, filesChanged: 4, linesAdded: 61, linesRemoved: 3 }
    const reply = appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Done.', turn: 1, summary })
    const untimed = { durationMs: null, filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
    const next = appendMessage(test.db, {
      taskId: task.id,
      role: MessageRole.Agent,
      body: 'Done again.',
      turn: 2,
      summary: untimed,
    })

    expect(reply.summary).toEqual(summary)
    expect(listMessages(test.db, task.id).map((message) => message.summary)).toEqual([summary, untimed])
    expect(next.summary).toEqual(untimed)
  })

  it('stores the images pasted into a message with it, in order, and lists them with it', () => {
    const message = appendMessage(test.db, {
      taskId: task.id,
      role: MessageRole.User,
      body: 'Compare these.',
      turn: 1,
      images: [PNG, JPEG],
    })

    expect(message.images.map(({ mediaType }) => mediaType)).toEqual([PNG.mediaType, JPEG.mediaType])
    expect(listMessages(test.db, task.id)).toEqual([message])
    expect(imagesOf(test.db, { kind: ImageOwnerKind.Message, id: message.id })).toEqual([PNG, JPEG])
  })

  it('stores a message that is only images, with no text', () => {
    const message = appendMessage(test.db, {
      taskId: task.id,
      role: MessageRole.User,
      body: '',
      turn: 1,
      images: [GIF],
    })

    expect(listMessages(test.db, task.id)).toEqual([message])
    expect(getImage(test.db, message.images[0]?.id ?? '')).toEqual(GIF)
  })

  it('gives each message only its own images', () => {
    const first = appendMessage(test.db, {
      taskId: task.id,
      role: MessageRole.User,
      body: 'One',
      turn: 1,
      images: [PNG],
    })
    const plain = appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Seen.', turn: 1 })
    const second = appendMessage(test.db, {
      taskId: task.id,
      role: MessageRole.User,
      body: 'Two',
      turn: 2,
      images: [GIF, JPEG],
    })

    expect(listMessages(test.db, task.id).map(({ images }) => images)).toEqual([first.images, [], second.images])
    expect(plain.images).toEqual([])
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

describe('lastTurn', () => {
  it("is the latest message's turn, or 0 before the first message", () => {
    expect(lastTurn(test.db, task.id)).toBe(0)
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 })
    appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Hello.', turn: 1 })
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Fix it.', turn: 2 })

    expect(lastTurn(test.db, task.id)).toBe(2)
  })

  it('counts a turn the agent started on its own by its turn divider, before it has any message', () => {
    const other = sampleTask(test.db, task.workspaceId)
    appendDivider(test.db, { taskId: other.id, turn: 9, dividerKind: DividerKind.Turn })
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 })
    appendDivider(test.db, { taskId: task.id, turn: 1, dividerKind: DividerKind.Turn })
    appendDivider(test.db, { taskId: task.id, turn: 2, dividerKind: DividerKind.Turn })
    expect(lastTurn(test.db, task.id)).toBe(2)

    // Only a turn divider starts a turn: other dividers and notes belong to one.
    appendDivider(test.db, { taskId: task.id, turn: 3, dividerKind: DividerKind.Reopened })
    appendNarration(test.db, { taskId: task.id, turn: 4, text: 'A note.' })
    expect(lastTurn(test.db, task.id)).toBe(2)
  })
})

describe('turnStartedAt', () => {
  it("is when the turn's first user message was sent, or null for a turn with none", () => {
    const other = sampleTask(test.db, task.workspaceId)
    appendMessage(test.db, { taskId: other.id, role: MessageRole.User, body: 'Elsewhere', turn: 1 }, 1_000)
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 }, 2_000)
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'And this.', turn: 1 }, 3_000)
    appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Hello.', turn: 1 }, 4_000)
    appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Unasked.', turn: 2 }, 5_000)

    expect(turnStartedAt(test.db, task.id, 1)).toBe(2_000)
    expect(turnStartedAt(test.db, task.id, 2)).toBeNull()
    expect(turnStartedAt(test.db, task.id, 3)).toBeNull()
  })

  it("is when a turn the agent started on its own opened, its turn divider's time", () => {
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 }, 2_000)
    appendDivider(test.db, { taskId: task.id, turn: 1, dividerKind: DividerKind.Turn }, 2_001)
    appendDivider(test.db, { taskId: task.id, turn: 2, dividerKind: DividerKind.Turn }, 6_000)
    appendDivider(test.db, { taskId: task.id, turn: 2, dividerKind: DividerKind.Resumed }, 5_000)
    appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Built.', turn: 2 }, 7_000)

    expect(turnStartedAt(test.db, task.id, 1)).toBe(2_000)
    expect(turnStartedAt(test.db, task.id, 2)).toBe(6_000)
  })
})

describe('firstUserMessageOfSession', () => {
  it("is the first message you sent the session's task, or undefined for no such session or message", () => {
    const other = sampleTask(test.db, task.workspaceId)
    updateTask(test.db, task.id, { sessionId: 'session-1' })
    updateTask(test.db, other.id, { sessionId: 'session-2' })
    appendMessage(test.db, { taskId: task.id, role: MessageRole.Agent, body: 'Unasked.', turn: 1 })
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 })
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: 'And this.', turn: 2 })

    expect(firstUserMessageOfSession(test.db, 'session-1')).toBe('Hi')
    expect(firstUserMessageOfSession(test.db, 'session-2')).toBeUndefined()
    expect(firstUserMessageOfSession(test.db, 'nope')).toBeUndefined()
  })
})
