import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AttachedFileKind, type AttachedFile } from '../../../shared/attachedFiles'
import { MessageRole, type Task } from '../../../shared/domain'
import {
  addAttachedFiles,
  AttachedFileOwnerKind,
  attachedFilesByOwner,
  attachedFilesOf,
  isAttachedFileSent,
  moveQueuedAttachedFiles,
} from './attached-files'
import { appendMessage, listMessages } from './messages'
import { appendQueuedMessage, listQueuedMessages, takeQueuedMessages } from './queued-messages'
import { RowError } from './rows'
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

function file(name: string, kind = AttachedFileKind.Text, size = 48 * 1024): AttachedFile {
  return { name, path: `.glade/attachments/${task.id}/${name}`, size, kind }
}

const message = (taskId = task.id) =>
  appendMessage(test.db, { taskId, role: MessageRole.User, body: 'Check these', turn: 1 })
const asMessage = (id: string) => ({ kind: AttachedFileOwnerKind.Message, id })
const asQueued = (id: string) => ({ kind: AttachedFileOwnerKind.QueuedMessage, id })
const asDraft = (id: string) => ({ kind: AttachedFileOwnerKind.Draft, id })

describe('addAttachedFiles', () => {
  it('stores each file in order, answering with it unchanged', () => {
    const { id } = message()
    const files = [
      file('sales.csv'),
      file('policy.pdf', AttachedFileKind.Binary, 0),
      file('chart.png', AttachedFileKind.Image),
    ]
    expect(addAttachedFiles(test.db, { taskId: task.id, owner: asMessage(id), files })).toEqual(files)
    expect(attachedFilesOf(test.db, asMessage(id))).toEqual(files)
  })

  it('stores nothing for a message without files', () => {
    const { id } = message()
    expect(addAttachedFiles(test.db, { taskId: task.id, owner: asMessage(id), files: [] })).toEqual([])
    expect(attachedFilesOf(test.db, asMessage(id))).toEqual([])
  })

  it('refuses to read back a kind it doesn’t know', () => {
    const { id } = message()
    addAttachedFiles(test.db, { taskId: task.id, owner: asMessage(id), files: [file('sales.csv')] })
    test.db.prepare("UPDATE attached_files SET kind = 'folder'").run()
    expect(() => attachedFilesOf(test.db, asMessage(id))).toThrow(RowError)
  })
})

it('gives a queued message its own files, which move to its message when the queue is delivered', () => {
  const queued = appendQueuedMessage(test.db, { taskId: task.id, body: '', files: [file('queued.log')] })
  expect(queued.files).toEqual([file('queued.log')])
  expect(listQueuedMessages(test.db, task.id)[0]?.files).toEqual([file('queued.log')])

  const [delivered] = takeQueuedMessages(test.db, task.id, 2)
  expect(delivered?.files).toEqual([file('queued.log')])
  expect(attachedFilesOf(test.db, asQueued(queued.id))).toEqual([])
  expect(listMessages(test.db, task.id)[0]?.files).toEqual([file('queued.log')])
})

it('moves a queued message’s files to a message, keeping their order', () => {
  const queued = appendQueuedMessage(test.db, { taskId: task.id, body: '' })
  addAttachedFiles(test.db, { taskId: task.id, owner: asQueued(queued.id), files: [file('a.csv'), file('b.csv')] })
  const { id } = message()
  moveQueuedAttachedFiles(test.db, queued.id, id)
  expect(attachedFilesOf(test.db, asMessage(id))).toEqual([file('a.csv'), file('b.csv')])
})

it("gives a task's draft its own files", () => {
  test.db.prepare("INSERT INTO input_drafts (task_id, text, updated_at) VALUES (?, '', 1)").run(task.id)
  addAttachedFiles(test.db, { taskId: task.id, owner: asDraft(task.id), files: [file('draft.csv')] })
  expect(attachedFilesOf(test.db, asDraft(task.id))).toEqual([file('draft.csv')])
})

describe('attachedFilesByOwner', () => {
  it("maps every message's files by its id, each in order", () => {
    const first = appendMessage(test.db, {
      taskId: task.id,
      role: MessageRole.User,
      body: '',
      turn: 1,
      files: [file('a.csv'), file('b.csv')],
    })
    const second = appendMessage(test.db, {
      taskId: task.id,
      role: MessageRole.User,
      body: '',
      turn: 2,
      files: [file('c.csv')],
    })

    expect(attachedFilesByOwner(test.db, task.id, AttachedFileOwnerKind.Message)).toEqual(
      new Map([
        [first.id, [file('a.csv'), file('b.csv')]],
        [second.id, [file('c.csv')]],
      ]),
    )
    expect(listMessages(test.db, task.id).map(({ files }) => files)).toEqual([
      [file('a.csv'), file('b.csv')],
      [file('c.csv')],
    ])
  })

  it('has nothing for a task with no files of that kind', () => {
    message()
    expect(attachedFilesByOwner(test.db, task.id, AttachedFileOwnerKind.Message)).toEqual(new Map())
  })
})

describe('isAttachedFileSent', () => {
  it('is true only for a file a sent or queued message of the task has, not one only in its draft', () => {
    test.db.prepare("INSERT INTO input_drafts (task_id, text, updated_at) VALUES (?, '', 1)").run(task.id)
    addAttachedFiles(test.db, { taskId: task.id, owner: asDraft(task.id), files: [file('draft.csv')] })
    appendMessage(test.db, { taskId: task.id, role: MessageRole.User, body: '', turn: 1, files: [file('sent.csv')] })
    appendQueuedMessage(test.db, { taskId: task.id, body: '', files: [file('queued.csv')] })
    const other = sampleTask(test.db, task.workspaceId)

    expect(isAttachedFileSent(test.db, task.id, file('draft.csv').path)).toBe(false)
    expect(isAttachedFileSent(test.db, task.id, file('sent.csv').path)).toBe(true)
    expect(isAttachedFileSent(test.db, task.id, file('queued.csv').path)).toBe(true)
    expect(isAttachedFileSent(test.db, other.id, file('sent.csv').path)).toBe(false)
  })
})
