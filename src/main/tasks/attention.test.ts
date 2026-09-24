// The unread rule end to end: a scripted agent session behind the real bridge (the preload's `window.glade` over a
// fake IPC pair), saving to a database in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type Task, type UiStateEntry } from '../../shared/domain'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import type { AgentRunner } from '../agent/runner'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { openTaskWithoutWindow } from './attention'
import { getTask } from '../db/repositories/tasks'
import { getUiState, setUiState } from '../db/repositories/ui-state'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'

let database: TestDatabase
let first: Task
let second: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]
/** Each reply the runner asked to notify, as its task's id and the reply. */
let notified: [string, string][]

/** Starts the app's main side on the test database, as a launch (or a relaunch) would. */
function launch(): void {
  backend = new FakeAgentBackend()
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    agentBackend: backend,
    notifyReply: (taskId, reply) => notified.push([taskId, reply]),
  }))
  glade = createBridge(ipc.renderer)
  events = []
  notified = []
  glade.subscribe((event) => events.push(event))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  const workspace = sampleWorkspace(database.db)
  first = sampleTask(database.db, workspace.id, 1_000)
  second = sampleTask(database.db, workspace.id, 2_000)
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

function current(task: Task): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** Opens a task, as the window does when you select it; null deselects. */
async function open(task: Task | null): Promise<void> {
  await glade.invoke(CommandName.UiStateSet, { key: UiStateKey.SelectedTaskId, value: task?.id ?? '' })
}

/** The unread flag of each `task.updated` since the last call, by task. */
function unreadUpdates(): [string, boolean][] {
  return events
    .splice(0)
    .flatMap((event): [string, boolean][] =>
      event.type === EventType.TaskUpdated ? [[event.task.id, event.task.unread]] : [],
    )
}

/** Sends the first task a message, and lets its agent reply. */
async function replyInFirst(reply = 'The redirect test reads the session before it is saved.'): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Why is the login test flaky?' })
  backend.session.emit(sdk.init(), sdk.text(reply), sdk.result(reply))
  await settle()
}

describe('unread', () => {
  it('marks a task unread when its agent replies while you view another, and keeps it across a restart', async () => {
    await open(first)
    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Why is the login test flaky?' })
    // You switch to another task before the agent answers.
    await open(second)
    events.splice(0)
    backend.session.emit(sdk.init(), sdk.text('It is a race.'), sdk.result('It is a race.'))
    await settle()

    expect(current(first)).toMatchObject({ unread: true, activity: TaskActivity.Waiting })
    expect(current(second).unread).toBe(false)
    const updates = unreadUpdates()
    expect(updates).toContainEqual([first.id, true])
    expect(updates.every(([id]) => id === first.id)).toBe(true)

    runner.close()
    launch()
    const { tasks } = await glade.invoke(CommandName.TasksList, { workspaceId: first.workspaceId })
    expect(tasks.find(({ id }) => id === first.id)?.unread).toBe(true)
  })

  it('never marks the task you are viewing unread', async () => {
    await open(first)
    await replyInFirst()

    expect(current(first).unread).toBe(false)
    expect(unreadUpdates().some(([, unread]) => unread)).toBe(false)
  })

  it('marks a task unread when nothing is selected', async () => {
    await open(null)
    await replyInFirst()

    expect(current(first).unread).toBe(true)
  })

  it('leaves the update time to the reply itself', async () => {
    await open(second)
    await replyInFirst()
    const replied = current(first)

    await open(first)

    expect(current(first)).toEqual({ ...replied, unread: false })
  })

  it('writes nothing more for a reply in a task that is already unread', async () => {
    await open(second)
    await replyInFirst()
    events.splice(0)

    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'And the fix?' })
    backend.session.emit(sdk.init(), sdk.result('Wait for the save.'))
    await settle()

    // Only the turn's own updates, working then waiting: no second write of the flag.
    expect(unreadUpdates()).toEqual([
      [first.id, true],
      [first.id, true],
    ])
  })

  it('leaves a task read when its turn ends without a reply, fails, or is stopped', async () => {
    await open(second)

    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Start the dev server.' })
    backend.session.emit(sdk.init(), sdk.result(''))
    await settle()
    expect(current(first)).toMatchObject({ unread: false, activity: TaskActivity.Waiting })

    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Run the tests.' })
    backend.session.emit(sdk.init(), sdk.apiErrorResult())
    await settle()
    expect(current(first)).toMatchObject({ unread: false, activity: TaskActivity.Error })

    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Run them again.' })
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.abortedText('Running the'), sdk.abortedResult())
      return Promise.resolve()
    }
    await glade.invoke(CommandName.TasksStop, { id: first.id })
    expect(current(first)).toMatchObject({ unread: false, activity: TaskActivity.Waiting })
  })

  it('marks a task read when you open it, and only then', async () => {
    await open(second)
    await replyInFirst()
    events.splice(0)

    await open(second)
    await open(null)
    expect(unreadUpdates()).toEqual([])
    expect(current(first).unread).toBe(true)

    await open(first)
    expect(current(first).unread).toBe(false)
    expect(unreadUpdates()).toEqual([[first.id, false]])

    // Opening a task that's already read writes nothing.
    await open(first)
    expect(unreadUpdates()).toEqual([])
  })

  it("keeps the task you're viewing unread when you mark it so, until you next open it", async () => {
    await open(first)
    const before = current(first)

    await glade.invoke(CommandName.TasksUpdate, { id: first.id, patch: { unread: true } })
    // Marking it unread isn't a change to the task: it keeps its place in the list.
    expect(current(first)).toEqual({ ...before, unread: true })
    expect(unreadUpdates()).toEqual([[first.id, true]])

    // Viewing it, even as its agent replies, leaves it unread.
    await replyInFirst()
    expect(current(first).unread).toBe(true)

    runner.close()
    launch()
    expect(current(first).unread).toBe(true)

    await open(second)
    expect(current(first).unread).toBe(true)
    await open(first)
    expect(current(first).unread).toBe(false)
  })

  it('ignores other UI state, and a selection of a task that does not exist', async () => {
    await open(second)
    await replyInFirst()
    events.splice(0)

    await glade.invoke(CommandName.UiStateSet, { key: UiStateKey.TaskFilter, value: first.id })
    await glade.invoke(CommandName.UiStateSet, { key: UiStateKey.SelectedTaskId, value: 'missing' })

    expect(unreadUpdates()).toEqual([])
    expect(current(first).unread).toBe(true)
  })
})

describe('notifications', () => {
  it('notifies a reply in a task you are not viewing, once, with the reply', async () => {
    await open(second)
    await replyInFirst('It is a **race**.')

    expect(notified).toEqual([[first.id, 'It is a **race**.']])
  })

  it('notifies a reply when nothing is selected', async () => {
    await open(null)
    await replyInFirst()

    expect(notified).toHaveLength(1)
  })

  it('never notifies a reply in the task you are viewing', async () => {
    await open(first)
    await replyInFirst()

    expect(notified).toEqual([])
  })

  it('notifies every reply in a task you are not viewing, even one that is already unread', async () => {
    await open(second)
    await replyInFirst('First.')
    await replyInFirst('Second.')

    expect(current(first).unread).toBe(true)
    expect(notified).toEqual([
      [first.id, 'First.'],
      [first.id, 'Second.'],
    ])
  })

  it('notifies nothing for a turn that ends without a reply, fails, or is stopped', async () => {
    await open(second)

    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Start the dev server.' })
    backend.session.emit(sdk.init(), sdk.result(''))
    await settle()
    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Run the tests.' })
    backend.session.emit(sdk.init(), sdk.apiErrorResult())
    await settle()
    await glade.invoke(CommandName.TasksSend, { id: first.id, text: 'Run them again.' })
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.abortedText('Running the'), sdk.abortedResult())
      return Promise.resolve()
    }
    await glade.invoke(CommandName.TasksStop, { id: first.id })

    expect(notified).toEqual([])
  })
})

describe('openTaskWithoutWindow', () => {
  it('selects the task and its workspace as clicking its row would, telling the windows, and reads it', async () => {
    const other = sampleWorkspace(database.db, '/code/other-api')
    const elsewhere = sampleTask(database.db, other.id, 3_000)
    setUiState(database.db, { key: UiStateKey.ActiveWorkspaceId, value: first.workspaceId })
    await open(second)
    await glade.invoke(CommandName.TasksSend, { id: elsewhere.id, text: 'Why is the login test flaky?' })
    backend.session.emit(sdk.init(), sdk.text('A race.'), sdk.result('A race.'))
    await settle()
    expect(current(elsewhere).unread).toBe(true)
    events.splice(0)

    openTaskWithoutWindow({ db: database.db, emit: (event) => events.push(event) }, elsewhere.id)

    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe(other.id)
    expect(getUiState(database.db, UiStateKey.SelectedTaskId)).toBe(elsewhere.id)
    expect(current(elsewhere).unread).toBe(false)
    const changed = events.flatMap((event): UiStateEntry[] =>
      event.type === EventType.UiStateChanged ? [event.entry] : [],
    )
    expect(changed).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: other.id },
      { key: UiStateKey.SelectedTaskId, value: elsewhere.id },
    ])
  })

  it('does nothing for a task that does not exist', async () => {
    await open(second)
    events.splice(0)

    openTaskWithoutWindow({ db: database.db, emit: (event) => events.push(event) }, 'missing')

    expect(getUiState(database.db, UiStateKey.SelectedTaskId)).toBe(second.id)
    expect(events).toEqual([])
  })
})
