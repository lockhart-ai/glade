// The unread rule end to end: a scripted agent session behind the real bridge (the preload's `window.glade` over a
// fake IPC pair), saving to a database in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type Task } from '../../shared/domain'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import type { AgentRunner } from '../agent/runner'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'

let database: TestDatabase
let first: Task
let second: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]

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
  }))
  glade = createBridge(ipc.renderer)
  events = []
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
