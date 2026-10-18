// What Glade tells an agent about usage (#688): the line at the end of every prompt a turn starts with, and the
// mid-turn note a working task gets as each of its messages' calls have run, once per threshold.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import { UsageLevel, UsageLimitKind, type UsageLimit, type UsageReading } from '../../shared/account'
import { SAMPLE_USAGE } from '../../shared/test-openrouter'
import { updateTask } from '../db/repositories/tasks'
import { saveUsageReading } from '../db/repositories/account'
import { updateSettings } from '../db/repositories/settings'
import { setOpenRouterConnection, setOpenRouterUsage } from '../db/repositories/openrouter'
import { getUsageNoteAnnouncements } from '../db/repositories/usage-note-announcements'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { FakeAgentBackend, settle, type FakeAgentSession } from './fake-backend'
import type { AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'

let database: TestDatabase
let backend: FakeAgentBackend
let runner: AgentRunner
let glade: GladeBridge
let workspaceId: string

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Starts the app's runner on the database, as a launch does. */
function launch(): void {
  backend = new FakeAgentBackend()
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
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
  }))
  glade = createBridge(ipc.renderer)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  workspaceId = sampleWorkspace(database.db).id
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

async function send(taskId: string, text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: taskId, text })
}

function reading(kind: UsageLimitKind, utilization: number | null, resetsIn: number | null): void {
  const at = Date.now()
  const value: UsageReading = {
    limit: { kind } as UsageLimit,
    utilization,
    resetsAt: resetsIn === null ? null : at + resetsIn,
    level: utilization === null ? UsageLevel.Limited : UsageLevel.Within,
    readAt: at,
  }
  saveUsageReading(database.db, value)
}

function readings(session: number | null, week: number | null): void {
  reading(UsageLimitKind.Session, session, 2 * HOUR)
  reading(UsageLimitKind.Weekly, week, 4 * DAY + 18 * HOUR)
}

/** Seeds an OpenRouter key whose all-time spend is `total` dollars, so the spend readings come from it. */
function openRouterSpend(total: number): void {
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('ciphertext'),
    models: [],
    providers: [],
  })
  setOpenRouterUsage(database.db, {
    connected: true,
    reading: { ...SAMPLE_USAGE, readAt: Date.now(), total },
    error: null,
  })
}

/** The task's session, started last for it; a relaunch's sessions are the only ones the new backend has. */
function sessionOf(taskId: string): FakeAgentSession {
  const session = backend.sessions.find((each) => each.options.taskId === taskId)
  if (session === undefined) throw new Error(`No session for task ${taskId}`)
  return session
}

describe('the usage line at a turn start', () => {
  it('ends every prompt a turn starts with, after the message', async () => {
    const task = sampleTask(database.db, workspaceId)
    readings(0.41, 0.59)

    await send(task.id, 'Get on with it.')

    const sent = sessionOf(task.id).sent[0]
    expect(sent?.text.startsWith('Get on with it.\n\n')).toBe(true)
    expect(sent?.text).toMatch(
      /^Get on with it\.\n\nUsage: session 41% \(resets ..:.. UTC\), week 59% \(resets [A-Z][a-z]{2} \d{1,2} ..:.. UTC\)\.$/,
    )
  })

  it('names the OpenRouter spend when the task runs on OpenRouter, and not otherwise', async () => {
    const task = updateTask(database.db, sampleTask(database.db, workspaceId).id, {
      model: 'openrouter:sample/small@sample-host',
    })
    readings(0.41, 0.59)
    openRouterSpend(12.345678)

    await send(task.id, 'Get on with it.')
    expect(sessionOf(task.id).sent[0]?.text).toContain(', OpenRouter spend $12.35.')

    const other = sampleTask(database.db, workspaceId)
    await send(other.id, 'Get on with it too.')
    const otherSent = sessionOf(other.id).sent[0]
    expect(otherSent?.text).toContain('Usage: session 41%')
    expect(otherSent?.text).not.toContain('OpenRouter')
  })

  it('changes no prompt when nothing says how much is used', async () => {
    const task = sampleTask(database.db, workspaceId)

    await send(task.id, 'Get on with it.')

    expect(sessionOf(task.id).sent[0]?.text).toBe('Get on with it.')
  })

  it('takes nothing after a command prompt', async () => {
    const task = sampleTask(database.db, workspaceId)
    readings(0.41, 0.59)
    await send(task.id, 'Get on with it.')
    const first = sessionOf(task.id).sent[0]?.text ?? ''

    // The turn ends, so the command's prompt can start one.
    backend.session.endTurn()
    backend.session.emit(sdk.result('On it.'))
    await settle()

    await send(task.id, '/compact')
    const sent = sessionOf(task.id).sent.at(-1)
    expect(sent?.text).toBe('/compact')
    expect(sent?.text).not.toBe(first)
  })
})

describe('the mid-turn note', () => {
  it('starts quiet, then tells each threshold crossed once, and nothing to an idle task', async () => {
    const task = sampleTask(database.db, workspaceId)
    const idle = sampleTask(database.db, workspaceId)
    readings(0.41, 0.59)
    await send(task.id, 'Get on with it.')
    const session = sessionOf(task.id)

    // A first check starts the task from where things stand; its prompts' line already said as much.
    await expect(session.finishBatch([])).resolves.toBeNull()
    expect(getUsageNoteAnnouncements(database.db, task.id)).toEqual({ session: 0.41, week: 0.59, spend: null })

    readings(0.52, 0.7)
    const note = await session.finishBatch([])
    expect(note).toContain('the session is now at 52%')
    expect(note).toContain('the week is now at 70%')
    expect(note?.startsWith('Usage: ')).toBe(true)
    expect(getUsageNoteAnnouncements(database.db, task.id)).toEqual({ session: 0.52, week: 0.7, spend: null })

    // The same thresholds never repeat.
    await expect(session.finishBatch([])).resolves.toBeNull()

    // An idle task is never told of anything, and never woken: it has no note and no session.
    expect(getUsageNoteAnnouncements(database.db, idle.id)).toBeUndefined()
  })

  it('tells the OpenRouter spend when it crosses its step', async () => {
    const task = sampleTask(database.db, workspaceId)
    readings(0.41, 0.59)
    openRouterSpend(12.345678)
    await send(task.id, 'Get on with it.')
    const session = sessionOf(task.id)
    await expect(session.finishBatch([])).resolves.toBeNull()

    setOpenRouterUsage(database.db, {
      connected: true,
      reading: { ...SAMPLE_USAGE, readAt: Date.now(), total: 20.05 },
      error: null,
    })
    // The key stays connected, so only its spend reading moves.
    const note = await session.finishBatch([])
    expect(note).toContain('OpenRouter spend is now $20.05')
    expect(note).not.toContain('the session')
    expect(note).not.toContain('the week')
  })

  it('respects the settings: the step, and off', async () => {
    const task = sampleTask(database.db, workspaceId)
    readings(0.41, 0.59)
    updateSettings(database.db, { usageNoteStepPercent: 20, usageNoteStepDollars: null })
    await send(task.id, 'Get on with it.')
    const session = sessionOf(task.id)
    await expect(session.finishBatch([])).resolves.toBeNull()

    // Ten points more is under the step: nothing.
    readings(0.52, 0.59)
    await expect(session.finishBatch([])).resolves.toBeNull()

    readings(0.65, 0.59)
    expect(await session.finishBatch([])).toContain('the session is now at 65%')
  })

  it('says nothing on the same thresholds after a relaunch, and the next crossing after it', async () => {
    const task = sampleTask(database.db, workspaceId)
    readings(0.41, 0.59)
    await send(task.id, 'Get on with it.')
    const session = sessionOf(task.id)
    await expect(session.finishBatch([])).resolves.toBeNull()
    readings(0.52, 0.7)
    expect(await session.finishBatch([])).toContain('the week is now at 70%')

    runner.close()
    launch()
    await send(task.id, 'Where were we?')
    const resumedSession = sessionOf(task.id)
    await expect(resumedSession.finishBatch([])).resolves.toBeNull()

    readings(0.65, 0.8)
    const note = await resumedSession.finishBatch([])
    expect(note).toContain('the session is now at 65%')
    expect(note).toContain('the week is now at 80%')
  })
})
