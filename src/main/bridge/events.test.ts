import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { MessageRole } from '../../shared/domain'
import { appendMessage } from '../db/repositories/messages'
import { appendNarration } from '../db/repositories/tool-events'
import { appendQueuedMessage } from '../db/repositories/queued-messages'
import {
  emitMessageAppended,
  emitQueueChanged,
  emitTaskUpdated,
  emitToolEventAppended,
  emitToolEventUpdated,
} from './events'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

it('emitTaskUpdated sends the whole task as a task.updated event', () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const emit = vi.fn()

  emitTaskUpdated(emit, task)

  expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.TaskUpdated, task })
})

it("emits a task's appended message and its appended and updated tool events", () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const message = appendMessage(database.db, { taskId: task.id, role: MessageRole.User, body: 'Hi', turn: 1 })
  const toolEvent = appendNarration(database.db, { taskId: task.id, turn: 1, text: 'Checking.' })
  const emit = vi.fn()

  emitMessageAppended(emit, message)
  emitToolEventAppended(emit, toolEvent)
  emitToolEventUpdated(emit, toolEvent)

  expect(emit.mock.calls).toEqual([
    [{ type: EventType.MessageAppended, message }],
    [{ type: EventType.ToolEventAppended, toolEvent }],
    [{ type: EventType.ToolEventUpdated, toolEvent }],
  ])
})

it("emits a task's whole queue as a queue.changed event", () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const queued = appendQueuedMessage(database.db, { taskId: task.id, body: 'Keep the filenames.' })
  const emit = vi.fn()

  emitQueueChanged(emit, task.id, [queued])

  expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.QueueChanged, taskId: task.id, queuedMessages: [queued] })
})
