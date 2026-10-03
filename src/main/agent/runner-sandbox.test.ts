// The agent sandbox in a running task (#445, `docs/sdk-notes.md` §15): what a session starts with, the overlay it gets
// straight after and on every mode change, which of its calls ask, and a sandbox that couldn't start. A fake agent
// session behind the real bridge, saving to a database in a temporary folder.
import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import {
  AgentErrorKind,
  PermissionDecisionKind,
  PermissionMode,
  TaskActivity,
  TaskErrorSource,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type PermissionRequest,
  type Task,
  type ToolCallEvent,
  type Workspace,
} from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { errorHeadline, errorOpening } from '../../shared/taskError'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { updateSettings } from '../db/repositories/settings'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { ToolPermissionBehavior, type ToolPermissionAnswer } from './backend'
import {
  FakeAgentBackend,
  settle,
  type AskedPermission,
  type FakeAgentSession,
  type PermissionCallFields,
} from './fake-backend'
import { NO_GRANTS, sandboxOverlay, sandboxStartSettings } from './sandbox'
import {
  networkAccessCall,
  outsideFileCall,
  FileAccess,
  sandboxInitFailure,
  sandboxOverrideCall,
  webFetchCall,
} from './sandbox-requests'
import { SANDBOX_FAILED_REFUSAL, SANDBOX_NOT_APPLIED, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

const HOME = homedir()
const ROOT = `${HOME}/src/acme-api`
const REASON = 'tlsTerminate: caCertPath and caKeyPath must be provided together'
const FAILURE = sandboxInitFailure(REASON)

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner

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
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  database = openTestDatabase()
  // The sandbox is off by default until P15's last PR: every test here but the ones that say otherwise turns it on.
  updateSettings(database.db, { sandboxEnabled: true })
  workspace = sampleWorkspace(database.db, ROOT)
  task = sampleTask(database.db, workspace.id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

function current(taskId = task.id): Task {
  const found = getTask(database.db, taskId)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

async function setMode(permissionMode: PermissionMode, taskId = task.id): Promise<void> {
  await glade.invoke(CommandName.TasksUpdate, { id: taskId, patch: { permissionMode } })
  await settle()
}

/** Sends a message, and has the session start its turn. */
async function startTurn(text = 'Run the tests.', taskId = task.id): Promise<FakeAgentSession> {
  await glade.invoke(CommandName.TasksSend, { id: taskId, text })
  const session = backend.session
  session.emit(sdk.init())
  await settle()
  return session
}

/** The agent calls a tool, and Claude Code asks about it: the `tool_use`, then `canUseTool`. */
async function callTool(session: FakeAgentSession, fields: PermissionCallFields): Promise<AskedPermission> {
  session.emit(sdk.toolUse(fields.toolUseId, fields.toolName, { ...fields.input }))
  await settle()
  const asked = session.requestPermission(fields)
  await settle()
  return asked
}

/** A `Bash` call that fails because the sandbox couldn't start: its hook hears it before its result streams. */
async function failingCommand(session: FakeAgentSession, toolUseId: string, command = 'npm test'): Promise<void> {
  session.emit(sdk.toolUse(toolUseId, 'Bash', { command }))
  await settle()
  await session.finishBash({ toolUseId, command, output: FAILURE, failed: true }).answer
  session.emit(sdk.toolResult(toolUseId, FAILURE, true))
  await settle()
}

function requests(taskId = task.id): PermissionRequest[] {
  return listPermissionRequests(database.db, taskId)
}

function toolCall(toolUseId: string, taskId = task.id): ToolCallEvent {
  const found = listToolEvents(database.db, taskId).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No tool call ${toolUseId}`)
  return found
}

const ALLOWED_AT_ONCE: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: false }
const REFUSED: ToolPermissionAnswer = {
  behavior: ToolPermissionBehavior.Deny,
  message: SANDBOX_FAILED_REFUSAL,
  byUser: false,
}

const OVERRIDE = { command: 'npm test', dangerouslyDisableSandbox: true }

describe('starting a session', () => {
  it('starts with only the fixed parts, whatever the mode, and the overlay before its first message', async () => {
    const order: string[] = []
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () => {
        order.push(`applied with ${String(session.sent.length)} sent`)
        return Promise.resolve()
      }
    }
    const session = await startTurn()

    expect(session.options.flagSettings).toEqual(sandboxStartSettings(ROOT))
    expect(session.options.flagSettings?.permissions?.allow).toBeUndefined()
    expect(session.options.hooks?.onBashFinished).toBeDefined()
    expect(session.flagSettings).toEqual([sandboxOverlay(ROOT, PermissionMode.AllowAll, NO_GRANTS)])
    expect(session.flagSettings[0]?.sandbox?.autoAllowBashIfSandboxed).toBe(true)
    expect(order).toEqual(['applied with 0 sent'])
    expect(session.sent).toHaveLength(1)
  })

  it('gives the ask mode an overlay that has every command ask', async () => {
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()

    expect(session.options.flagSettings).toEqual(sandboxStartSettings(ROOT))
    expect(session.flagSettings).toEqual([sandboxOverlay(ROOT, PermissionMode.AskBeforeEdits, NO_GRANTS)])
    expect(session.flagSettings[0]?.sandbox?.autoAllowBashIfSandboxed).toBe(false)
  })

  it('with the sandbox off, starts exactly as before: no sandbox, no Bash hook, no overlay', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    const session = await startTurn()

    expect(session.options).not.toHaveProperty('flagSettings')
    expect(Object.keys(session.options.hooks ?? {}).sort()).toEqual([
      'onBashStarting',
      'onCompacted',
      'onPrompt',
      'onTurnEnded',
    ])
    expect(session.flagSettings).toEqual([])
  })

  it('is off until you turn it on: by default a session starts unsandboxed', async () => {
    expect(DEFAULT_SETTINGS.sandboxEnabled).toBe(false)
    database.db.prepare("DELETE FROM settings WHERE key = 'sandboxEnabled'").run()
    const session = await startTurn()

    expect(session.options).not.toHaveProperty('flagSettings')
    expect(session.flagSettings).toEqual([])
    expect(session.sent).toHaveLength(1)
  })

  it('holds the first message, and a settings change after it, until the overlay is applied, then sends them in order', async () => {
    const pending: (() => void)[] = []
    const applied = (): void => {
      for (const resolve of pending.splice(0)) resolve()
    }
    const order: string[] = []
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () =>
        new Promise<void>((resolve) => {
          pending.push(resolve)
        })
      const send = session.send.bind(session)
      const configure = session.configure.bind(session)
      session.send = (...args) => {
        order.push('send')
        send(...args)
      }
      session.configure = (...args) => {
        order.push('configure')
        configure(...args)
      }
    }
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Run the tests.' })
    await setMode(PermissionMode.AskBeforeEdits)
    const session = backend.session

    expect(session.sent).toEqual([])
    expect(session.configured).toEqual([])
    expect(current().activity).toBe(TaskActivity.Working)

    applied()
    await settle()

    expect(order).toEqual(['send', 'configure'])
    expect(session.sent.map(({ text }) => text)).toEqual(['Run the tests.'])
  })

  it('reads the setting as each session starts: a running session keeps the sandbox it started with', async () => {
    const first = await startTurn()
    updateSettings(database.db, { sandboxEnabled: false })
    first.emit(sdk.result('Done.'))
    await settle()
    await startTurn('And again.')

    expect(backend.sessions).toHaveLength(1)
    const asked = await callTool(first, { toolUseId: 'toolu_out', toolName: 'Bash', input: OVERRIDE })
    await settle()
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_out'])
    asked.abort()
  })
})

describe('changing the mode', () => {
  it('switches a running session mid-turn, and whether its commands ask with it, without restarting it', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }))
    await settle()

    await setMode(PermissionMode.AskBeforeEdits)
    await setMode(PermissionMode.AllowAll)

    expect(backend.sessions).toHaveLength(1)
    expect(session.configured.map(({ permissionMode }) => permissionMode)).toEqual([
      PermissionMode.AskBeforeEdits,
      PermissionMode.AllowAll,
    ])
    expect(session.flagSettings.map(({ sandbox }) => sandbox?.autoAllowBashIfSandboxed)).toEqual([true, false, true])
    expect(session.flagSettings[1]).toEqual(sandboxOverlay(ROOT, PermissionMode.AskBeforeEdits, NO_GRANTS))
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('with the sandbox off, changes only the mode', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    const session = await startTurn()
    await setMode(PermissionMode.AskBeforeEdits)

    expect(session.configured).toHaveLength(1)
    expect(session.flagSettings).toEqual([])
  })
})

describe('an overlay the session won’t take', () => {
  const NOT_APPLIED = `${SANDBOX_NOT_APPLIED}settings_not_applied`

  /** Every session started from now on refuses its overlays, as the SDK would, or throws applying them. */
  function refuseOverlays(how: 'reject' | 'throw' = 'reject'): void {
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () => {
        if (how === 'throw') throw new Error('settings_not_applied')
        return Promise.reject(new Error('settings_not_applied'))
      }
    }
  }

  /** Every session started from now on takes its overlays. */
  function takeOverlays(): void {
    backend.onSessionStart = () => undefined
  }

  it.each([PermissionMode.AllowAll, PermissionMode.AskBeforeEdits])(
    'never starts a session whose first overlay is refused in %s: no message is sent, and the task stops on the error',
    async (mode) => {
      await setMode(mode)
      refuseOverlays()
      await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Run the tests.' })
      await settle()
      const session = backend.session

      expect(session.flagSettings).toHaveLength(1)
      expect(session.sent).toEqual([])
      expect(session.configured).toEqual([])
      expect(session.closed).toBe(true)
      expect(current()).toMatchObject({
        activity: TaskActivity.Error,
        error: { kind: AgentErrorKind.Permanent, source: TaskErrorSource.Sandbox, details: NOT_APPLIED },
      })
      expect(errorOpening(current().error)).toEqual({ lead: 'The sandbox couldn’t start: ', label: NOT_APPLIED })
      expect(errorHeadline(current().error)).toBe('the sandbox couldn’t start')
      // Your message is still in the chat, for Retry.
      expect(listMessages(database.db, task.id).map(({ body }) => body)).toEqual(['Run the tests.'])
    },
  )

  it('does the same when applying the overlay throws', async () => {
    refuseOverlays('throw')
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Run the tests.' })
    await settle()

    expect(backend.session.sent).toEqual([])
    expect(backend.session.closed).toBe(true)
    expect(current()).toMatchObject({
      activity: TaskActivity.Error,
      error: { source: TaskErrorSource.Sandbox, details: NOT_APPLIED },
    })
  })

  it('starts cleanly on a later Retry: a new session, its overlay, then the same message', async () => {
    refuseOverlays()
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Run the tests.' })
    await settle()
    takeOverlays()

    await glade.invoke(CommandName.TasksRetry, { id: task.id })
    await settle()

    expect(backend.sessions).toHaveLength(2)
    const session = backend.session
    expect(session.flagSettings).toEqual([sandboxOverlay(ROOT, PermissionMode.AllowAll, NO_GRANTS)])
    expect(session.sent.map(({ text }) => text)).toEqual(['Run the tests.'])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, error: null })
    session.emit(sdk.init(), sdk.result('All 42 tests pass.'))
    await settle()
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, error: null })
    expect(listMessages(database.db, task.id).map(({ body }) => body)).toEqual(['Run the tests.', 'All 42 tests pass.'])
  })

  it('starts cleanly on a new message instead, too', async () => {
    refuseOverlays()
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Run the tests.' })
    await settle()
    takeOverlays()

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Try the build instead.' })
    await settle()

    expect(backend.sessions).toHaveLength(2)
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Try the build instead.'])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, error: null })
  })

  it('closes a running session that refuses the overlay for a new mode, ending its turn on the error', async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }))
    await settle()
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings_not_applied'))

    await setMode(PermissionMode.AskBeforeEdits)

    expect(session.closed).toBe(true)
    expect(toolCall('toolu_01')).toMatchObject({ state: ToolCallState.Error, output: NOT_APPLIED })
    expect(current()).toMatchObject({
      activity: TaskActivity.Error,
      error: { source: TaskErrorSource.Sandbox, details: NOT_APPLIED },
    })
  })

  it('closes an idle session that refuses it without an error: the next message starts a new one', async () => {
    const session = await startTurn()
    session.emit(sdk.result('Done.'))
    await settle()
    session.onApplyFlagSettings = () => Promise.reject(new Error('settings_not_applied'))

    await setMode(PermissionMode.AskBeforeEdits)

    expect(session.closed).toBe(true)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, error: null })

    const next = await startTurn('And the build.')
    expect(backend.sessions).toHaveLength(2)
    expect(next.flagSettings).toEqual([sandboxOverlay(ROOT, PermissionMode.AskBeforeEdits, NO_GRANTS)])
    expect(next.sent.map(({ text }) => text)).toEqual(['And the build.'])
  })

  it('leaves a session that failed by itself meanwhile with its own error', async () => {
    let refuse: (error: Error) => void = () => undefined
    backend.onSessionStart = (session) => {
      session.onApplyFlagSettings = () =>
        new Promise<void>((_, reject) => {
          refuse = reject
        })
    }
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Run the tests.' })
    await settle()
    backend.session.fail(new Error('spawn ENOENT'))
    await settle()
    refuse(new Error('settings_not_applied'))
    await settle()

    expect(backend.session.sent).toEqual([])
    expect(current()).toMatchObject({
      activity: TaskActivity.Error,
      error: { source: TaskErrorSource.Session, details: 'The agent stopped: spawn ENOENT' },
    })
  })
})

describe('what asks', () => {
  it.each([PermissionMode.AllowAll, PermissionMode.AskBeforeEdits])(
    'asks about crossing the bounds in %s, with the existing card',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()

      await callTool(
        session,
        outsideFileCall(
          'toolu_read',
          'Read',
          { file_path: `${HOME}/notes/a.md` },
          `${HOME}/notes/a.md`,
          FileAccess.Read,
        ),
      )
      await callTool(
        session,
        outsideFileCall(
          'toolu_write',
          'Write',
          { file_path: '/tmp/out.txt', content: 'x' },
          '/tmp/out.txt',
          FileAccess.Write,
        ),
      )
      await callTool(
        session,
        webFetchCall('toolu_fetch', { url: 'https://docs.acme.dev/retries', prompt: 'Summarize.' }),
      )
      const network = networkAccessCall('registry.npmjs.org', 'b5a6dac2-network')
      await callTool(session, network)

      expect(requests().map(({ toolUseId }) => toolUseId)).toEqual([
        'toolu_read',
        'toolu_write',
        'toolu_fetch',
        'b5a6dac2-network',
      ])
      expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    },
  )

  it.each([PermissionMode.AllowAll, PermissionMode.AskBeforeEdits])(
    "doesn't ask about reads in the root or outside the home folder, or WebSearch, in %s",
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()

      const reads = [
        await callTool(session, { toolUseId: 'toolu_hosts', toolName: 'Read', input: { file_path: '/etc/hosts' } }),
        await callTool(session, {
          toolUseId: 'toolu_mine',
          toolName: 'Read',
          input: { file_path: `${ROOT}/README.md` },
        }),
        await callTool(session, { toolUseId: 'toolu_search', toolName: 'WebSearch', input: { query: 'backoff' } }),
      ]

      for (const asked of reads) await expect(asked.answer).resolves.toEqual(ALLOWED_AT_ONCE)
      expect(requests()).toEqual([])
    },
  )

  it('lets everything else inside the bounds go in Allow all, as acceptEdits would ask about it', async () => {
    const session = await startTurn()

    const asked = [
      await callTool(session, { toolUseId: 'toolu_bash', toolName: 'Bash', input: { command: 'npm test' } }),
      await callTool(session, { toolUseId: 'toolu_edit', toolName: 'Edit', input: { file_path: `${ROOT}/a.ts` } }),
    ]

    for (const answer of asked) await expect(answer.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(requests()).toEqual([])
  })

  it.each([PermissionMode.AllowAll, PermissionMode.AskBeforeEdits])(
    'asks about running outside the sandbox in %s, with or without a reason, even when a task rule matches',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()

      await callTool(session, sandboxOverrideCall('toolu_reason', OVERRIDE, true))
      // A P11 task rule matching the command: no reason, no ask rule named.
      await callTool(session, { toolUseId: 'toolu_none', toolName: 'Bash', input: OVERRIDE })

      expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_reason', 'toolu_none'])
    },
  )

  it('with the sandbox off, decides as before', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    const session = await startTurn()

    const asked = await callTool(session, { toolUseId: 'toolu_out', toolName: 'Bash', input: OVERRIDE })
    const read = await callTool(session, {
      toolUseId: 'toolu_read',
      toolName: 'Read',
      input: { file_path: `${HOME}/x` },
    })

    await expect(asked.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    await expect(read.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(requests()).toEqual([])
  })
})

describe('a sandbox that can’t start', () => {
  it.each([PermissionMode.AllowAll, PermissionMode.AskBeforeEdits])(
    'refuses every request to run outside it without a card, the first and every later one, in %s',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()
      await failingCommand(session, 'toolu_01')

      const first = await callTool(session, sandboxOverrideCall('toolu_02', OVERRIDE, true))
      const second = await callTool(session, {
        toolUseId: 'toolu_03',
        toolName: 'Bash',
        input: { ...OVERRIDE, command: 'npm run build' },
      })

      await expect(first.answer).resolves.toEqual(REFUSED)
      await expect(second.answer).resolves.toEqual(REFUSED)
      expect(requests()).toEqual([])
      expect(toolCall('toolu_01')).toMatchObject({ state: ToolCallState.Error, output: FAILURE })
      expect(current().awaitingPermission).toBe(false)
    },
  )

  it('ends the turn on the error, naming why, with the card and the task list line', async () => {
    const session = await startTurn()
    await failingCommand(session, 'toolu_01')
    session.emit(sdk.text("The sandbox couldn't start, so I couldn't run the tests."), sdk.result('Done.'))
    await settle()

    const { error } = current()
    expect(current().activity).toBe(TaskActivity.Error)
    expect(error).toEqual({
      kind: AgentErrorKind.Permanent,
      source: TaskErrorSource.Sandbox,
      status: null,
      code: null,
      details: FAILURE,
      retries: 0,
      retryingMs: 0,
    })
    expect(errorOpening(error).label).toBe(REASON)
  })

  it('still refuses in the next turn of the same session, and ends it on the error again', async () => {
    const session = await startTurn()
    await failingCommand(session, 'toolu_01')
    session.emit(sdk.result('Done.'))
    await settle()

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Try again.' })
    await settle()
    const asked = await callTool(session, { toolUseId: 'toolu_02', toolName: 'Bash', input: OVERRIDE })
    await expect(asked.answer).resolves.toEqual(REFUSED)
    session.emit(sdk.result('I still can’t.'))
    await settle()

    expect(backend.sessions).toHaveLength(1)
    // Nothing failed in this turn: the session's sandbox is still down, but the turn ends as usual.
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('shows the error at once when a background command fails between turns', async () => {
    const session = await startTurn()
    session.emit(sdk.result('Started the build in the background.'))
    await settle()

    await session.finishBash({ toolUseId: 'toolu_bg', command: 'npm run build', output: FAILURE, failed: true }).answer
    await settle()

    expect(current()).toMatchObject({ activity: TaskActivity.Error, error: { source: TaskErrorSource.Sandbox } })
  })

  it.each([
    ['a command that exited 0 printing it', { output: FAILURE, failed: false }],
    ['a command that failed otherwise', { output: `Exit code 1\n${FAILURE}`, failed: true }],
    ['a blocked read', { output: 'Exit code 1\ncat: x: Operation not permitted', failed: true }],
  ])("isn't fooled by %s", async (_what, finished) => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_01', 'Bash', { command: 'cat notes.md' }))
    await settle()
    await session.finishBash({ toolUseId: 'toolu_01', command: 'cat notes.md', ...finished }).answer
    session.emit(sdk.toolResult('toolu_01', finished.output, finished.failed))
    await settle()

    await callTool(session, { toolUseId: 'toolu_02', toolName: 'Bash', input: OVERRIDE })
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_02'])
  })

  it("isn't fooled by the text in another tool's result, or in the agent's own message", async () => {
    const session = await startTurn()
    session.emit(sdk.toolUse('toolu_read', 'Read', { file_path: `${ROOT}/NOTES.md` }))
    session.emit(sdk.toolResult('toolu_read', FAILURE, true))
    session.emit(sdk.text(`Claude Code once said: ${FAILURE}`))
    await settle()

    await callTool(session, { toolUseId: 'toolu_02', toolName: 'Bash', input: OVERRIDE })
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_02'])
    session.emit(sdk.result('Done.'))
    await settle()
    expect(current().error).toBeNull()
  })

  it('leaves other tasks’ sessions alone', async () => {
    const other = sampleTask(database.db, workspace.id, 3_000)
    const failing = await startTurn()
    await failingCommand(failing, 'toolu_01')
    const healthy = await startTurn('Build it.', other.id)

    expect(backend.sessions).toHaveLength(2)
    await callTool(healthy, { toolUseId: 'toolu_other', toolName: 'Bash', input: OVERRIDE })
    expect(requests(other.id).map(({ toolUseId }) => toolUseId)).toEqual(['toolu_other'])
  })

  it('retries in a new session, whose sandbox gets another go and runs normally', async () => {
    const first = await startTurn()
    await failingCommand(first, 'toolu_01')
    first.emit(sdk.result('Done.'))
    await settle()

    await glade.invoke(CommandName.TasksRetry, { id: task.id })
    await settle()

    expect(first.closed).toBe(true)
    expect(backend.sessions).toHaveLength(2)
    const second = backend.session
    expect(second.options.flagSettings).toEqual(sandboxStartSettings(ROOT))
    expect(current()).toMatchObject({ activity: TaskActivity.Working, error: null })
    second.emit(sdk.init())
    await callTool(second, { toolUseId: 'toolu_02', toolName: 'Bash', input: OVERRIDE })
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_02'])
    await glade.invoke(CommandName.PermissionsAnswer, {
      id: requests()[0]?.id ?? '',
      decision: { kind: PermissionDecisionKind.Deny },
    })
  })
})
