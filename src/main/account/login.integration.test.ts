// Logging in to Claude end to end in main (#409): a task stops on a lost login, Log in runs the login (a fake here:
// a test never runs Claude Code's), and once you're logged in the task that asked is retried, in a session started
// again; Retry all retries the rest.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { AgentErrorKind, TaskActivity, type Task } from '../../shared/domain'
import { IDLE_LOGIN, LoginState } from '../../shared/login'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge, type RegisteredBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { LoginOutcomeKind, type LoginOutcome, type RunLogin } from './login'

const NOT_LOGGED_IN = 'Not logged in · Please run /login'

let database: TestDatabase
let tasks: Task[]
let backend: FakeAgentBackend
let bridge: RegisteredBridge
let glade: GladeBridge
let events: GladeEvent[]
/** Ends the login running now, as the browser would. */
let finishLogin: (outcome: LoginOutcome) => void
let logins: number

const runLogin: RunLogin = () => {
  logins += 1
  return {
    done: new Promise<LoginOutcome>((resolve) => {
      finishLogin = resolve
    }),
    cancel: () => {
      finishLogin({ kind: LoginOutcomeKind.Cancelled })
    },
  }
}

beforeEach(() => {
  database = openTestDatabase()
  const workspaceId = sampleWorkspace(database.db).id
  tasks = [sampleTask(database.db, workspaceId, 1_000), sampleTask(database.db, workspaceId, 2_000)]
  backend = new FakeAgentBackend()
  logins = 0
  const ipc = fakeIpcPair()
  bridge = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: backend,
    runLogin,
  })
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
})

afterEach(() => {
  bridge.login.close()
  bridge.runner.close()
  database.close()
})

function current(index: number): Task | undefined {
  const task = tasks[index]
  return task === undefined ? undefined : getTask(database.db, task.id)
}

/** Sends the task a message whose turn fails because nothing is signed in, as Claude Code says it. */
async function stopLoggedOut(index: number): Promise<void> {
  const task = tasks[index]
  if (task === undefined) throw new Error(`No task ${String(index)}`)
  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Move the uploads to S3.' })
  backend.session.emit(
    sdk.init(),
    sdk.apiErrorMessage('authentication_failed', NOT_LOGGED_IN),
    sdk.apiErrorResult(NOT_LOGGED_IN, null),
  )
  await settle()
}

function loginEvents(): unknown[] {
  return events.flatMap((event) => (event.type === EventType.LoginChanged ? [event.status] : []))
}

describe('logging in from a logged-out task', () => {
  it('stops each task on a logged-out error', async () => {
    await stopLoggedOut(0)
    await stopLoggedOut(1)

    expect(current(0)).toMatchObject({ activity: TaskActivity.Error, error: { kind: AgentErrorKind.LoggedOut } })
    expect(current(1)).toMatchObject({ activity: TaskActivity.Error, error: { kind: AgentErrorKind.LoggedOut } })
    expect((await glade.invoke(CommandName.LoginStatus, {})).status).toEqual(IDLE_LOGIN)
  })

  it('retries only the task whose Log in was clicked once you’re in, in a session started again', async () => {
    await stopLoggedOut(0)
    await stopLoggedOut(1)
    const sessions = backend.sessions.length

    const { status } = await glade.invoke(CommandName.LoginStart, { taskId: tasks[0]?.id ?? '' })
    expect(status.state).toBe(LoginState.Waiting)
    expect(current(0)?.activity).toBe(TaskActivity.Error)

    finishLogin({ kind: LoginOutcomeKind.LoggedIn })
    await settle()

    expect(loginEvents().map((event) => (event as { state: LoginState }).state)).toEqual([
      LoginState.Waiting,
      LoginState.LoggedIn,
    ])
    expect(current(0)).toMatchObject({ activity: TaskActivity.Working, error: null })
    expect(backend.sessions).toHaveLength(sessions + 1)
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    // The other waits for its own Retry, or Retry all.
    expect(current(1)?.activity).toBe(TaskActivity.Error)
    expect(logins).toBe(1)
  })

  it('retries every task still logged out with Retry all, and answers with them', async () => {
    await stopLoggedOut(0)
    await stopLoggedOut(1)

    const { tasks: retried } = await glade.invoke(CommandName.TasksRetryLoggedOut, {})

    expect(retried.map(({ id }) => id)).toEqual(tasks.map(({ id }) => id))
    expect(current(0)?.activity).toBe(TaskActivity.Working)
    expect(current(1)?.activity).toBe(TaskActivity.Working)
  })

  it('forgets the login once a retried task stops logged out again', async () => {
    await stopLoggedOut(0)
    await glade.invoke(CommandName.LoginStart, { taskId: tasks[0]?.id ?? '' })
    finishLogin({ kind: LoginOutcomeKind.LoggedIn })
    await settle()
    expect(bridge.login.status().state).toBe(LoginState.LoggedIn)

    backend.session.emit(
      sdk.init(),
      sdk.apiErrorMessage('authentication_failed', NOT_LOGGED_IN),
      sdk.apiErrorResult(NOT_LOGGED_IN, null),
    )
    await settle()

    expect(current(0)?.activity).toBe(TaskActivity.Error)
    expect(bridge.login.status()).toEqual(IDLE_LOGIN)
  })

  it('says why a login failed, and cancels one running', async () => {
    await stopLoggedOut(0)
    await glade.invoke(CommandName.LoginStart, { taskId: null })
    finishLogin({ kind: LoginOutcomeKind.Failed, message: 'Login failed: timed out' })
    await settle()
    expect((await glade.invoke(CommandName.LoginStatus, {})).status).toEqual({
      state: LoginState.Failed,
      message: 'Login failed: timed out',
    })

    await glade.invoke(CommandName.LoginStart, { taskId: tasks[0]?.id ?? '' })
    expect((await glade.invoke(CommandName.LoginCancel, {})).status).toEqual(IDLE_LOGIN)
    await settle()
    expect(current(0)?.activity).toBe(TaskActivity.Error)
  })
})
