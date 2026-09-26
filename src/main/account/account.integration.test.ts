// The account and its usage warning end to end in main: what the agent's sessions say, through the runner, into SQLite
// and out to the window, alongside the pauses a spent limit brings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { UsageWindow } from '../../shared/account'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { PauseReason, TaskActivity, type Task } from '../../shared/domain'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import { SCRIPTED_ACCOUNT } from '../agent/scripted-session'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge, type RegisteredBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'

let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let bridge: RegisteredBridge
let glade: GladeBridge
let events: GladeEvent[]
let log: MemoryLog

function start(): void {
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
    log: log.logger,
  })
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
}

beforeEach(() => {
  log = createMemoryLog()
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  backend = new FakeAgentBackend()
  start()
})

afterEach(() => {
  bridge.runner.close()
  bridge.account.close()
  database.close()
  vi.useRealTimers()
})

async function status() {
  return (await glade.invoke(CommandName.AccountStatus, {})).status
}

function accountEvents(): GladeEvent[] {
  return events.filter((event) => event.type === EventType.AccountChanged)
}

/** A rate limit event warning that `utilization` of the session window is used, resetting `inMs` from now. */
function warning(utilization: number, inMs = 3_600_000): unknown {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: Math.ceil((Date.now() + inMs) / 1000),
      rateLimitType: 'five_hour',
      utilization,
    },
    uuid: 'rate-limit-warning',
    session_id: sdk.SESSION_ID,
  }
}

describe('the account', () => {
  it('is read from each session as it starts, kept, and shown to the window', async () => {
    backend.onAccountInfo = () => Promise.resolve(SCRIPTED_ACCOUNT)
    expect(await status()).toEqual({ account: null, usageWarning: null })

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    await settle()

    expect(backend.session.accountInfoCalls).toBe(1)
    const { account } = await status()
    expect(account).toMatchObject({ email: 'sam@acme.dev', subscriptionType: 'Claude Max', apiProvider: 'firstParty' })
    expect(accountEvents()).toEqual([{ type: EventType.AccountChanged, status: { account, usageWarning: null } }])

    // Every turn after is the same session: it isn't asked again.
    backend.session.emit(sdk.init(), sdk.text('Done.'), sdk.result('Done.'))
    await settle()
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Thanks.' })
    await settle()
    expect(backend.session.accountInfoCalls).toBe(1)
  })

  it('is still there after a relaunch, before any task starts', async () => {
    backend.onAccountInfo = () => Promise.resolve({ tokenSource: 'none', apiProvider: 'firstParty' })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    await settle()
    bridge.runner.close()
    bridge.account.close()

    start()

    expect((await status()).account).toMatchObject({ tokenSource: 'none', email: null })
  })

  it('keeps the account it had when a session can’t say, and logs why', async () => {
    backend.onAccountInfo = () => Promise.resolve({ email: 'sam@acme.dev' })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    await settle()
    const before = (await status()).account

    backend.onAccountInfo = () => Promise.reject(new Error('The agent process exited'))
    bridge.runner.discard(task.id)
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Try again.' })
    await settle()

    expect((await status()).account).toEqual(before)
    expect(log.withMessage("couldn't read the account")).toHaveLength(1)
  })

  it('ignores what a session says once it has been closed', async () => {
    let answer: (info: unknown) => void = () => undefined
    backend.onAccountInfo = () =>
      new Promise((resolve) => {
        answer = resolve
      })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    bridge.runner.discard(task.id)

    answer({ email: 'sam@acme.dev' })
    await settle()

    expect((await status()).account).toBeNull()
  })
})

describe('the usage warning', () => {
  it('stands while a session says the limit is close, then gives way to a pause once it is spent', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(sdk.init(), warning(0.85))
    await settle()
    expect((await status()).usageWarning).toMatchObject({ utilization: 0.85, window: UsageWindow.Session })

    // Warning, then pause: the limit runs out, the task pauses, and the warning is over.
    backend.session.emit(...sdk.usageLimitTurnEnd(Math.ceil(Date.now() / 1000) + 3600))
    await settle()
    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Paused,
      pause: { reason: PauseReason.UsageLimit },
    })
    expect((await status()).usageWarning).toBeNull()
    expect(
      accountEvents().map((event) => event.type === EventType.AccountChanged && event.status.usageWarning),
    ).toEqual([expect.objectContaining({ utilization: 0.85 }), null])
  })

  it('goes on its own when its window resets, while tasks keep working', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(sdk.init(), warning(0.9, 60_000))
    await vi.waitFor(async () => {
      expect((await status()).usageWarning).not.toBeNull()
    })

    // Warning, then reset: the SDK gives the reset to the second, rounded up.
    vi.advanceTimersByTime(61_000)
    expect((await status()).usageWarning).toBeNull()
    expect(accountEvents().at(-1)).toEqual({
      type: EventType.AccountChanged,
      status: { account: null, usageWarning: null },
    })
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)
  })

  it('shows nothing for a limit that stays fine, as an API key session never says', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(...sdk.turnStartNoise(), sdk.text('Done.'), sdk.result('Done.'))
    await settle()

    expect(accountEvents()).toEqual([])
  })
})
