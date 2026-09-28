import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageRole, type Task } from '../../../shared/domain'
import { appendMessage } from './messages'
import { appendQueuedMessage } from './queued-messages'
import {
  addPastedBlocks,
  moveQueuedPastedBlocks,
  PastedBlockOwnerKind,
  pastedBlocksByOwner,
  pastedBlocksOf,
} from './pasted-blocks'
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

const message = (taskId = task.id) =>
  appendMessage(test.db, { taskId, role: MessageRole.User, body: 'See this', turn: 1 })
const asMessage = (id: string) => ({ kind: PastedBlockOwnerKind.Message, id })
const asQueued = (id: string) => ({ kind: PastedBlockOwnerKind.QueuedMessage, id })
const asDraft = (id: string) => ({ kind: PastedBlockOwnerKind.Draft, id })

describe('addPastedBlocks', () => {
  it('stores each block in order, answering with it unchanged', () => {
    const { id } = message()
    const one = { id: 'k3f9', text: 'first pasted block' }
    const two = { id: 'a1b2c3', text: 'second\npasted\nblock' }
    const stored = addPastedBlocks(test.db, { taskId: task.id, owner: asMessage(id), blocks: [one, two] })

    expect(stored).toEqual([one, two])
    expect(pastedBlocksOf(test.db, asMessage(id))).toEqual([one, two])
  })

  it('stores nothing for a message without pasted blocks', () => {
    const { id } = message()
    expect(addPastedBlocks(test.db, { taskId: task.id, owner: asMessage(id), blocks: [] })).toEqual([])
    expect(pastedBlocksOf(test.db, asMessage(id))).toEqual([])
  })

  it('keeps two blocks with the same tag id apart (position, not the id, tells them apart)', () => {
    const { id } = message()
    const blocks = [
      { id: 'dup', text: 'first' },
      { id: 'dup', text: 'second' },
    ]
    addPastedBlocks(test.db, { taskId: task.id, owner: asMessage(id), blocks })
    expect(pastedBlocksOf(test.db, asMessage(id))).toEqual(blocks)
  })
})

it('gives a queued message its own blocks, until the queue delivers it', () => {
  const queued = appendQueuedMessage(test.db, { taskId: task.id, body: '' })
  const block = { id: 'k3f9', text: 'pasted while queued' }
  addPastedBlocks(test.db, { taskId: task.id, owner: asQueued(queued.id), blocks: [block] })
  expect(pastedBlocksOf(test.db, asQueued(queued.id))).toEqual([block])

  const { id: messageId } = message()
  moveQueuedPastedBlocks(test.db, queued.id, messageId)
  expect(pastedBlocksOf(test.db, asQueued(queued.id))).toEqual([])
  expect(pastedBlocksOf(test.db, asMessage(messageId))).toEqual([block])
})

it("gives a task's draft its own blocks", () => {
  test.db.prepare("INSERT INTO input_drafts (task_id, text, updated_at) VALUES (?, '', 1)").run(task.id)
  const block = { id: 'k3f9', text: 'pasted into the draft' }
  addPastedBlocks(test.db, { taskId: task.id, owner: asDraft(task.id), blocks: [block] })
  expect(pastedBlocksOf(test.db, asDraft(task.id))).toEqual([block])
})

describe('pastedBlocksByOwner', () => {
  it("maps every message's blocks by its id, each in order", () => {
    const first = message()
    const second = message()
    const a = { id: 'aaa111', text: 'a' }
    const b = { id: 'bbb222', text: 'b' }
    const c = { id: 'ccc333', text: 'c' }
    addPastedBlocks(test.db, { taskId: task.id, owner: asMessage(first.id), blocks: [a, b] })
    addPastedBlocks(test.db, { taskId: task.id, owner: asMessage(second.id), blocks: [c] })

    expect(pastedBlocksByOwner(test.db, task.id, PastedBlockOwnerKind.Message)).toEqual(
      new Map([
        [first.id, [a, b]],
        [second.id, [c]],
      ]),
    )
  })

  it('has nothing for a task with no blocks of that kind', () => {
    message()
    expect(pastedBlocksByOwner(test.db, task.id, PastedBlockOwnerKind.Message)).toEqual(new Map())
  })
})
