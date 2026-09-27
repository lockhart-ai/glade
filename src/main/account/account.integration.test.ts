// The account and its usage readings end to end in main: what the agent's sessions say, through the runner, into SQLite
// and out to the window, alongside the pauses a spent limit brings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { UsageLevel, UsageLimitKind } from '../../shared/account'
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
    expect(await status()).toEqual({ account: null, usage: [] })

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    await settle()

    expect(backend.session.accountInfoCalls).toBe(1)
    const { account } = await status()
    expect(account).toMatchObject({ email: 'sam@acme.dev', subscriptionType: 'Claude Max', apiProvider: 'firstParty' })
    expect(accountEvents()).toEqual([{ type: EventType.AccountChanged, status: { account, usage: [] } }])

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

/** The usage call's answer: the session `session`% used, the week 22%, resetting in two hours and four days. */
function usageAnswer(session: number): unknown {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString()
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: session, resets_at: at(2 * 3_600_000) },
      seven_day: { utilization: 22, resets_at: at(4 * 24 * 3_600_000) },
    },
    behaviors: null,
  }
}

/** How much of each limit is used, as the window has it: `session: 0.38`. */
async function usage(): Promise<Record<string, number | null>> {
  return Object.fromEntries((await status()).usage.map((reading) => [reading.limit.kind, reading.utilization]))
}

describe('the usage meter', () => {
  it('reads the usage call as each session starts and after each turn', async () => {
    let session = 38
    backend.onUsage = () => Promise.resolve(usageAnswer(session))
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    await settle()
    expect(backend.session.usageCalls).toBe(1)
    expect(await usage()).toEqual({ [UsageLimitKind.Session]: 0.38, [UsageLimitKind.Weekly]: 0.22 })

    session = 41
    backend.session.emit(sdk.init(), sdk.text('Done.'), sdk.result('Done.'))
    await settle()
    expect(backend.session.usageCalls).toBe(2)
    expect(await usage()).toMatchObject({ [UsageLimitKind.Session]: 0.41 })
    expect(accountEvents()).toHaveLength(2)
  })

  it('falls back to the rate limit events when the call fails, and says why in the log', async () => {
    backend.onUsage = () => Promise.reject(new Error('This SDK has no usage call.'))
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(sdk.init(), warning(0.85), sdk.text('Done.'), sdk.result('Done.'))
    await settle()

    expect((await status()).usage).toEqual([expect.objectContaining({ utilization: 0.85, level: UsageLevel.Warning })])
    expect(log.withMessage("couldn't read usage: going on with the rate limit events")).toHaveLength(2)
  })

  it('falls back to the rate limit events when the call answers something unexpected', async () => {
    backend.onUsage = () => Promise.resolve({ usage: 'unexpected' })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(sdk.init(), warning(0.9), sdk.text('Done.'), sdk.result('Done.'))
    await settle()

    expect(await usage()).toEqual({ [UsageLimitKind.Session]: 0.9 })
  })

  it('is at the limit once it runs out, while the task pauses as before', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(sdk.init(), warning(0.85))
    backend.session.emit(...sdk.usageLimitTurnEnd(Math.ceil(Date.now() / 1000) + 3600))
    await settle()

    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Paused,
      pause: { reason: PauseReason.UsageLimit },
    })
    expect((await status()).usage).toEqual([expect.objectContaining({ utilization: 0.85, level: UsageLevel.Limited })])
  })

  it('keeps its readings across a relaunch', async () => {
    backend.onUsage = () => Promise.resolve(usageAnswer(38))
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    await settle()
    bridge.runner.close()
    bridge.account.close()

    start()

    expect(await usage()).toEqual({ [UsageLimitKind.Session]: 0.38, [UsageLimitKind.Weekly]: 0.22 })
  })

  it('drops a reading when its window resets, while tasks keep working', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(sdk.init(), warning(0.9, 60_000))
    await vi.waitFor(async () => {
      expect((await status()).usage).toHaveLength(1)
    })

    // The SDK gives the reset to the second, rounded up.
    vi.advanceTimersByTime(61_000)
    expect((await status()).usage).toEqual([])
    expect(accountEvents().at(-1)).toEqual({ type: EventType.AccountChanged, status: { account: null, usage: [] } })
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)
  })

  it('reads nothing for an API key session, which gets no events and no plan limits', async () => {
    backend.onUsage = () =>
      Promise.resolve({ subscription_type: null, rate_limits_available: false, rate_limits: null })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the uploads.' })
    backend.session.emit(...sdk.turnStartNoise(), sdk.text('Done.'), sdk.result('Done.'))
    await settle()

    expect(accountEvents()).toEqual([])
  })

  it('ignores what a session says of usage once it has been closed', async () => {
    let answer: (usage: unknown) => void = () => undefined
    backend.onUsage = () =>
      new Promise((resolve) => {
        answer = resolve
      })
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Add rate limiting.' })
    bridge.runner.discard(task.id)

    answer(usageAnswer(38))
    await settle()

    expect((await status()).usage).toEqual([])
  })
})
