// Follow-ups the agent schedules itself with the SDK's own tools (`docs/sdk-notes.md` §11): a `Monitor` whose events
// and end each wake it, and `ScheduleWakeup` and `CronCreate` jobs that fire later. Each wake is a turn the agent starts
// on its own (#162), streamed here in the shapes the real SDK was seen to stream, behind the real bridge, saving to a
// database in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Task,
  type ToolEvent,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import type { NotifyReply } from '../notifications/notifications'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle } from './fake-backend'
import { RESUME_PROMPT, STOPPED_NOTE, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let notifyReply: ReturnType<typeof vi.fn<NotifyReply>>

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
    agentBackend: backend,
    notifyReply,
  }))
  glade = createBridge(ipc.renderer)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  // You're looking at another task, so a reply marks this one unread and is notified.
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: 'another-task' })
  notifyReply = vi.fn<NotifyReply>()
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
}

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

function chat(): unknown[] {
  return listMessages(database.db, task.id).map(({ role, body, turn }) => ({ role, body, turn }))
}

/** The tool log from turn 2 on, briefly. */
function laterToolLog(): unknown[] {
  return listToolEvents(database.db, task.id)
    .filter((event) => event.turn >= 2)
    .map((event: ToolEvent) => {
      switch (event.kind) {
        case ToolEventKind.Divider:
          return { divider: event.dividerKind, turn: event.turn }
        case ToolEventKind.Narration:
          return { narration: event.text, turn: event.turn }
        case ToolEventKind.ToolCall:
          return { call: event.name, state: event.state, turn: event.turn }
        case ToolEventKind.Compaction:
          return { compaction: event.state, turn: event.turn }
      }
    })
}

/** What the runner warned about: nothing the SDK streams for a follow-up should be dropped or misread. */
function warnings(): unknown[] {
  return vi.mocked(console.warn).mock.calls
}

/** When the woken turn is stopped, the SDK aborts it, as it was seen to (`docs/sdk-notes.md` §11). */
function abortOnInterrupt(origin: 'task-notification' | null): void {
  backend.session.onInterrupt = () => {
    backend.session.emit(
      sdk.interruptMarker(true),
      sdk.result('', {
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
        ...(origin === null ? {} : { origin: { kind: origin } }),
      }),
    )
    return Promise.resolve()
  }
}

describe('a Monitor', () => {
  const WATCH = ['toolu_mon', 'bl14', 'CI checks on PR #42'] as const

  /** A first turn that arms the watch and replies at once, as the probe saw. */
  async function armWatch(): Promise<void> {
    await send('Watch CI on PR #42.')
    backend.session.emit(
      sdk.init(),
      ...sdk.monitorStarted(...WATCH),
      sdk.text("I'm watching the CI checks.", null, 'msg_02'),
      sdk.result("I'm watching the CI checks."),
    )
    await settle()
  }

  /** An event from the watch: straight into a turn, with no notification first. */
  function event(reply: string, messageId: string): unknown[] {
    return [sdk.init(), sdk.thinking(messageId), sdk.text(reply, null, messageId), sdk.selfStartedResult(reply)]
  }

  it('returns as soon as the watch starts: its call is done, and the turn ends, waiting on you', async () => {
    await armWatch()

    const monitor = listToolEvents(database.db, task.id).find((row) => row.kind === ToolEventKind.ToolCall)
    expect(monitor).toMatchObject({ name: 'Monitor', state: ToolCallState.Done, turn: 1 })
    expect(current().activity).toBe(TaskActivity.Waiting)
    // You can talk to it straight away: your message is the next turn, not queued.
    await send('Anything yet?')
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Watch CI on PR #42.', 'Anything yet?'])
  })

  it('wakes the agent into a turn of its own for each event, then once more when the watch ends', async () => {
    await armWatch()

    backend.session.emit(...event('Lint passed.', 'msg_03'))
    await settle()
    backend.session.emit(...event('The unit tests failed.', 'msg_04'))
    await settle()
    backend.session.emit(...sdk.monitorEnded(...WATCH), ...event('The CI run is done.', 'msg_05'))
    await settle()

    expect(chat().slice(2)).toEqual([
      { role: MessageRole.Agent, body: 'Lint passed.', turn: 2 },
      { role: MessageRole.Agent, body: 'The unit tests failed.', turn: 3 },
      { role: MessageRole.Agent, body: 'The CI run is done.', turn: 4 },
    ])
    expect(laterToolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 2 },
      { divider: DividerKind.Turn, turn: 3 },
      { divider: DividerKind.Turn, turn: 4 },
    ])
    expect(current()).toMatchObject({ unread: true, activity: TaskActivity.Waiting })
    expect(notifyReply.mock.calls.map(([, reply]) => reply)).toEqual([
      "I'm watching the CI checks.",
      'Lint passed.',
      'The unit tests failed.',
      'The CI run is done.',
    ])
    // The watch ending leaves its call as it was: done in the turn that armed it.
    const monitor = listToolEvents(database.db, task.id).find((row) => row.kind === ToolEventKind.ToolCall)
    expect(monitor).toMatchObject({ name: 'Monitor', state: ToolCallState.Done, turn: 1 })
    expect(warnings()).toEqual([])
  })

  it('Stop cuts short the turn an event woke; the watch carries on and wakes the agent again', async () => {
    await armWatch()
    backend.session.emit(
      sdk.init(),
      sdk.text('The unit tests failed. Reading the log.', null, 'msg_03'),
      sdk.toolUse('toolu_log', 'Bash', { command: 'npm run ci:log' }, null, 'msg_03'),
    )
    await settle()
    expect(current().activity).toBe(TaskActivity.Working)
    abortOnInterrupt('task-notification')

    await glade.invoke(CommandName.TasksStop, { id: task.id })

    expect(backend.session.interrupts).toBe(1)
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(laterToolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 2 },
      { narration: 'The unit tests failed. Reading the log.', turn: 2 },
      { call: 'Bash', state: ToolCallState.Error, turn: 2 },
      { narration: STOPPED_NOTE, turn: 2 },
    ])
    expect(chat()).toHaveLength(2)

    backend.session.emit(...sdk.monitorEnded(...WATCH), ...event('The CI run is done.', 'msg_04'))
    await settle()
    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'The CI run is done.', turn: 3 })
  })

  it('folds an event that arrives while you are waiting on a reply into that turn', async () => {
    await armWatch()
    await send('Is lint done?')
    const [, , question] = listMessages(database.db, task.id)

    // The SDK takes the event first, as a turn of its own, then answers you.
    backend.session.emit(...event('Lint passed.', 'msg_03'))
    await settle()
    backend.session.emit(
      sdk.init(),
      sdk.text('Yes, lint passed.', null, 'msg_04'),
      sdk.result('Yes, lint passed.', { user_message_uuids: [question?.id] }),
    )
    await settle()

    expect(chat().slice(2)).toEqual([
      { role: MessageRole.User, body: 'Is lint done?', turn: 2 },
      { role: MessageRole.Agent, body: 'Lint passed.', turn: 2 },
      { role: MessageRole.Agent, body: 'Yes, lint passed.', turn: 3 },
    ])
    expect(current().activity).toBe(TaskActivity.Waiting)
  })
})

describe.each([
  {
    tool: 'ScheduleWakeup',
    input: { delaySeconds: 300, reason: 'Check the rollout', prompt: 'Check the rollout.', noop: false },
    output: 'Next wakeup scheduled for 14:05:00 (in 300s).',
  },
  {
    tool: 'CronCreate',
    input: { cron: '30 14 25 9 *', prompt: 'Check the migration.', recurring: false, durable: false },
    output: 'Scheduled one-shot task c3f81a2e (30 14 25 9 *). Session-only (not written to disk).',
  },
])('a $tool job', ({ tool, input, output }) => {
  /** A first turn that schedules the job and replies at once. */
  async function schedule(): Promise<void> {
    await send('Check on it later.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_job', tool, input),
      sdk.toolResult('toolu_job', output),
      sdk.text("I'll check back later.", null, 'msg_02'),
      sdk.result("I'll check back later."),
    )
    await settle()
  }

  it('returns at once, and the turn ends, waiting on you', async () => {
    await schedule()

    const call = listToolEvents(database.db, task.id).find((row) => row.kind === ToolEventKind.ToolCall)
    expect(call).toMatchObject({ name: tool, state: ToolCallState.Done, output })
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('firing, wakes the agent into a turn of its own, saved, unread and notified', async () => {
    await schedule()
    const firedAt = Date.now()

    backend.session.emit(
      sdk.scheduledFire(),
      sdk.init(),
      ...sdk.turnStartNoise(),
      sdk.text('Checking.', null, 'msg_03'),
      sdk.toolUse('toolu_check', 'Bash', { command: 'npm run deploy:status' }, null, 'msg_03'),
    )
    await settle()
    expect(current().activity).toBe(TaskActivity.Working)

    backend.session.emit(
      sdk.toolResult('toolu_check', 'Rollout complete.'),
      sdk.text('The rollout finished.', null, 'msg_04'),
      sdk.scheduledResult('The rollout finished.'),
    )
    await settle()

    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Check on it later.', turn: 1 },
      { role: MessageRole.Agent, body: "I'll check back later.", turn: 1 },
      { role: MessageRole.Agent, body: 'The rollout finished.', turn: 2 },
    ])
    expect(laterToolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 2 },
      { narration: 'Checking.', turn: 2 },
      { call: 'Bash', state: ToolCallState.Done, turn: 2 },
    ])
    // Timed from when it fired, not from your message.
    expect(listMessages(database.db, task.id).at(-1)?.summary?.durationMs).toBeLessThanOrEqual(Date.now() - firedAt)
    expect(current()).toMatchObject({ unread: true, activity: TaskActivity.Waiting })
    expect(notifyReply).toHaveBeenLastCalledWith(task.id, 'The rollout finished.')
    expect(warnings()).toEqual([])
  })

  it('two firing together are one turn, as the SDK runs them', async () => {
    await schedule()

    backend.session.emit(
      sdk.scheduledFire('c7d1e2f3-0000-4000-8000-000000000001'),
      sdk.scheduledFire('c7d1e2f3-0000-4000-8000-000000000002'),
      sdk.init(),
      sdk.text('Both checks are done.', null, 'msg_03'),
      sdk.scheduledResult('Both checks are done.'),
    )
    await settle()

    expect(chat().slice(2)).toEqual([{ role: MessageRole.Agent, body: 'Both checks are done.', turn: 2 }])
  })

  it('Stop cuts short the turn it woke the agent for', async () => {
    await schedule()
    backend.session.emit(
      sdk.scheduledFire(),
      sdk.init(),
      sdk.text('Checking.', null, 'msg_03'),
      sdk.toolUse('toolu_check', 'Bash', { command: 'npm run deploy:status' }, null, 'msg_03'),
    )
    await settle()
    abortOnInterrupt(null)

    await glade.invoke(CommandName.TasksStop, { id: task.id })

    expect(backend.session.interrupts).toBe(1)
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(laterToolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 2 },
      { narration: 'Checking.', turn: 2 },
      { call: 'Bash', state: ToolCallState.Error, turn: 2 },
      { narration: STOPPED_NOTE, turn: 2 },
    ])
    expect(chat()).toHaveLength(2)
    // A message now is the next turn.
    await send('Try again.')
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Try again.', turn: 3 })
  })

  it('firing in a done task runs, and leaves it done', async () => {
    await schedule()
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })

    backend.session.emit(sdk.scheduledFire(), sdk.init(), sdk.text('Checked.', null, 'msg_03'))
    await settle()
    expect(current()).toMatchObject({ state: TaskState.Done, activity: TaskActivity.Working })
    backend.session.emit(sdk.scheduledResult('Checked.'))
    await settle()

    expect(current()).toMatchObject({ state: TaskState.Done, activity: TaskActivity.Waiting, unread: true })
    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'Checked.', turn: 2 })
  })

  it('firing mid-turn after a relaunch, is carried on like any turn the app quit in', async () => {
    await schedule()
    backend.session.emit(sdk.scheduledFire(), sdk.init(), sdk.text('Checking.', null, 'msg_03'))
    await settle()

    runner.close()
    launch()
    expect(runner.resumeInterrupted()).toEqual([task.id])
    expect(backend.session.sent.map(({ text }) => text)).toEqual([RESUME_PROMPT])
    await expect(glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Hello?' })).rejects.toMatchObject({
      code: BridgeErrorCode.Busy,
    })
  })
})
