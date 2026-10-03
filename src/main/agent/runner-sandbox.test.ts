// The agent sandbox in a running task (#445, `docs/sdk-notes.md` §15): what a session starts with, the overlay it gets
// straight after and on every mode change, which of its calls ask, and a sandbox that couldn't start. A fake agent
// session behind the real bridge, saving to a database in a temporary folder. The home folder is a temporary one too,
// so the paths the sandbox resolves are never the machine's own.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import {
  AgentErrorKind,
  PermissionDecisionKind,
  PermissionDestination,
  PermissionMode,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  TaskActivity,
  TaskErrorSource,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type PermissionDecision,
  type PermissionRequest,
  type Task,
  type ToolCallEvent,
  type Workspace,
} from '../../shared/domain'
import { taskPermissionRule } from '../../shared/permissions'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { errorHeadline, errorOpening } from '../../shared/taskError'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { updateSettings } from '../db/repositories/settings'
import { addTaskPermissionRule, listTaskPermissionRules } from '../db/repositories/task-permission-rules'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
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
import { GrantProblem, NO_GRANTS, sandboxOverlay, sandboxStartSettings } from './sandbox'
import { FolderAccess } from '../../shared/sandbox'
import {
  networkAccessCall,
  outsideFileCall,
  FileAccess,
  sandboxInitFailure,
  sandboxOverrideCall,
  webFetchCall,
} from './sandbox-requests'
import {
  createAgentRunner,
  CREDENTIAL_REFUSAL,
  SANDBOX_FAILED_REFUSAL,
  SANDBOX_NOT_APPLIED,
  SANDBOX_RESTARTED_NOTE,
  type AgentRunner,
} from './runner'
import * as sdk from './test-sdk-messages'

/** A home folder of the tests' own, made before anything reads where home is. */
const FAKE_HOME = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glade-home-')))
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => FAKE_HOME }
  return { ...mocked, default: mocked }
})

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true })
})

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

function only(toolUseId: string, taskId = task.id): PermissionRequest {
  const found = requests(taskId).find((request) => request.toolUseId === toolUseId)
  if (found === undefined) throw new Error(`No request for ${toolUseId}`)
  return found
}

async function answer(toolUseId: string, decision: PermissionDecision, taskId = task.id): Promise<void> {
  await glade.invoke(CommandName.PermissionsAnswer, { id: only(toolUseId, taskId).id, decision })
  await settle()
}

const ALLOWED_AT_ONCE: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: false }
const ALLOWED_BY_YOU: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: true }
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

  it('lets a command Claude Code asks about go in Allow all: the sandbox bounds it', async () => {
    const session = await startTurn()

    const asked = await callTool(session, { toolUseId: 'toolu_bash', toolName: 'Bash', input: { command: 'npm test' } })

    await expect(asked.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(requests()).toEqual([])
  })

  it.each([
    ['the MCP servers the next session starts', '.mcp.json'],
    ['Claude Code’s own settings', '.claude/settings.local.json'],
    ['git’s config', '.git/config'],
    ['an ordinary file an ask rule or a safety check held back', 'src/retry.ts'],
  ])('asks, in Allow all, about a write inside the root that reaches it: %s', async (_what, file) => {
    const session = await startTurn()

    const asked = await callTool(session, {
      toolUseId: 'toolu_write',
      toolName: 'Write',
      input: { file_path: `${ROOT}/${file}`, content: '{}' },
    })

    expect(requests()).toEqual([
      expect.objectContaining({ toolUseId: 'toolu_write', state: PermissionRequestState.Open }),
    ])
    // Only once, or not at all.
    expect(taskPermissionRule(only('toolu_write'))).toBeNull()
    await answer('toolu_write', { kind: PermissionDecisionKind.AllowOnce })
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it.each([PermissionMode.AllowAll, PermissionMode.AskBeforeEdits])(
    'refuses a credential path in %s without a card, however it’s spelled',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()

      const asked = [
        await callTool(session, {
          toolUseId: 'toolu_key',
          toolName: 'Read',
          input: { file_path: `${HOME}/.ssh/id_rsa` },
        }),
        await callTool(session, {
          toolUseId: 'toolu_tilde',
          toolName: 'Read',
          input: { file_path: '~/.aws/credentials' },
        }),
        await callTool(session, {
          toolUseId: 'toolu_alias',
          toolName: 'Edit',
          input: { file_path: `/System/Volumes/Data${HOME}/.netrc` },
        }),
      ]

      for (const { answer: given } of asked) {
        await expect(given).resolves.toEqual({
          behavior: ToolPermissionBehavior.Deny,
          message: CREDENTIAL_REFUSAL,
          byUser: false,
        })
      }
      expect(requests()).toEqual([])
    },
  )

  it('asks about another spelling of the home folder, and a link in the root that leads out of it', async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'glade-sandbox-')))
    try {
      const root = join(folder, 'acme-api')
      mkdirSync(root)
      mkdirSync(join(folder, 'private'))
      // What a sandboxed command may do: make a link in the root, here to a folder standing in for ~/Documents.
      symlinkSync(join(folder, 'private'), join(root, 'link'))
      const linked = sampleTask(database.db, sampleWorkspace(database.db, root).id, 4_000)
      const session = await startTurn('Read the notes.', linked.id)

      const through = await callTool(session, {
        toolUseId: 'toolu_link',
        toolName: 'Write',
        input: { file_path: join(root, 'link', 'out.txt'), content: 'x' },
      })
      await callTool(session, {
        toolUseId: 'toolu_case',
        toolName: 'Read',
        input: { file_path: `${HOME.toUpperCase()}/Documents/taxes.pdf` },
      })
      await callTool(session, {
        toolUseId: 'toolu_tilde',
        toolName: 'Read',
        input: { file_path: '~/Documents/taxes.pdf' },
      })

      expect(requests(linked.id).map(({ toolUseId }) => toolUseId)).toEqual(['toolu_link', 'toolu_case', 'toolu_tilde'])
      through.abort()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
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

describe('Allow for this task', () => {
  const WHOLE_WRITE = { toolName: 'Write' }
  const WHOLE_EDIT = { toolName: 'Edit' }
  const NPM_TEST = { toolName: 'Bash', ruleContent: 'npm test *' }

  function rules(taskId = task.id): unknown[] {
    return listTaskPermissionRules(database.db, taskId).map(({ rule }) => rule)
  }

  it.each([PermissionMode.AllowAll, PermissionMode.AskBeforeEdits])(
    'isn’t offered on a boundary crossing in %s: the write’s rule would be the whole tool, for every folder',
    async (mode) => {
      await setMode(mode)
      const session = await startTurn()
      const out = '/tmp/glade-out.txt'
      const write = outsideFileCall('toolu_write', 'Write', { file_path: out, content: 'x' }, out, FileAccess.Write)
      const asked = await callTool(session, write)
      await callTool(session, webFetchCall('toolu_fetch', { url: 'https://docs.acme.dev/x', prompt: 'Summarize.' }))
      await callTool(session, sandboxOverrideCall('toolu_out', OVERRIDE, true))

      for (const toolUseId of ['toolu_write', 'toolu_fetch', 'toolu_out']) {
        expect(only(toolUseId).suppressAlwaysAllowRule).toBe(true)
        expect(taskPermissionRule(only(toolUseId))).toBeNull()
      }
      await expect(answer('toolu_write', { kind: PermissionDecisionKind.AllowForTask })).rejects.toThrow()
      expect(only('toolu_write').state).toBe(PermissionRequestState.Open)
      expect(rules()).toEqual([])

      await answer('toolu_write', { kind: PermissionDecisionKind.AllowOnce })
      await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
      // Once only: the same write asks again.
      await callTool(session, { ...write, toolUseId: 'toolu_again' })
      expect(only('toolu_again').state).toBe(PermissionRequestState.Open)
    },
  )

  it('keeps a whole-tool rule the task already has from a sandboxed session, and decides its calls itself', async () => {
    for (const rule of [WHOLE_WRITE, WHOLE_EDIT, NPM_TEST, { toolName: 'Read' }, { toolName: 'WebFetch' }]) {
      addTaskPermissionRule(database.db, { taskId: task.id, rule })
    }
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()

    // Claude Code would take `Write` for every folder: only the command rule reaches it.
    expect(session.options.allowedRules).toEqual([NPM_TEST])

    const inside = await callTool(session, {
      toolUseId: 'toolu_in',
      toolName: 'Write',
      input: { file_path: `${ROOT}/CHANGELOG.md`, content: 'x' },
    })
    await expect(inside.answer).resolves.toEqual(ALLOWED_AT_ONCE)

    await callTool(session, {
      toolUseId: 'toolu_agents',
      toolName: 'Write',
      input: { file_path: `${HOME}/Library/LaunchAgents/x.plist`, content: 'x' },
    })
    await callTool(session, {
      toolUseId: 'toolu_mcp',
      toolName: 'Edit',
      input: { file_path: `${ROOT}/.mcp.json` },
    })
    await callTool(session, { toolUseId: 'toolu_read', toolName: 'Read', input: { file_path: `${HOME}/Documents/a` } })
    await callTool(session, { toolUseId: 'toolu_fetch', toolName: 'WebFetch', input: { url: 'https://example.org/' } })
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual([
      'toolu_agents',
      'toolu_mcp',
      'toolu_read',
      'toolu_fetch',
    ])
  })

  it('in Allow all, still asks about a write that reaches it, whatever the task was granted', async () => {
    addTaskPermissionRule(database.db, { taskId: task.id, rule: WHOLE_WRITE })
    const session = await startTurn()

    expect(session.options.allowedRules).toEqual([])
    await callTool(session, { toolUseId: 'toolu_mcp', toolName: 'Write', input: { file_path: `${ROOT}/.mcp.json` } })
    expect(only('toolu_mcp').state).toBe(PermissionRequestState.Open)
  })

  it('granted on an edit in the ask mode, is kept by the task and never handed to the sandboxed session', async () => {
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()
    const edit = { toolName: 'Edit', input: { file_path: `${ROOT}/src/retry.ts` } }

    const first = await callTool(session, { ...edit, toolUseId: 'toolu_01' })
    expect(taskPermissionRule(only('toolu_01'))).toEqual(WHOLE_EDIT)
    await answer('toolu_01', { kind: PermissionDecisionKind.AllowForTask })

    // The session gets the allow, not the rule: it would let Edit write anywhere.
    await expect(first.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(rules()).toEqual([WHOLE_EDIT])

    const second = await callTool(session, { ...edit, toolUseId: 'toolu_02' })
    await expect(second.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    await callTool(session, { toolName: 'Edit', toolUseId: 'toolu_03', input: { file_path: `${HOME}/.zshrc` } })
    expect(only('toolu_03').state).toBe(PermissionRequestState.Open)
    // Another write tool wasn't granted.
    await callTool(session, { toolName: 'Write', toolUseId: 'toolu_04', input: { file_path: `${ROOT}/a.md` } })
    expect(only('toolu_04').state).toBe(PermissionRequestState.Open)
  })

  it('hands a command’s rule to a sandboxed session as before', async () => {
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()
    const suggestions = [
      {
        type: PermissionUpdateType.AddRules,
        rules: [NPM_TEST],
        behavior: PermissionRuleBehavior.Allow,
        destination: PermissionDestination.LocalSettings,
      },
    ] as const

    const asked = await callTool(session, {
      toolUseId: 'toolu_01',
      toolName: 'Bash',
      input: { command: 'npm test' },
      suggestions,
    })
    await answer('toolu_01', { kind: PermissionDecisionKind.AllowForTask })

    await expect(asked.answer).resolves.toEqual({ ...ALLOWED_BY_YOU, rule: NPM_TEST })
  })

  it('with the sandbox off, passes whole-tool rules to the session, and hands it the ones granted, as before', async () => {
    updateSettings(database.db, { sandboxEnabled: false })
    addTaskPermissionRule(database.db, { taskId: task.id, rule: WHOLE_WRITE })
    await setMode(PermissionMode.AskBeforeEdits)
    const session = await startTurn()

    expect(session.options.allowedRules).toEqual([WHOLE_WRITE])
    const asked = await callTool(session, { toolUseId: 'toolu_01', toolName: 'Edit', input: { file_path: 'a.ts' } })
    await answer('toolu_01', { kind: PermissionDecisionKind.AllowForTask })
    await expect(asked.answer).resolves.toEqual({ ...ALLOWED_BY_YOU, rule: WHOLE_EDIT })
  })
})

describe('grants', () => {
  it('leaves a grant the sandbox can’t take out of the overlay and the bounds, and logs it', async () => {
    runner.close()
    const log = createMemoryLog(LogScope.Runner)
    backend = new FakeAgentBackend()
    runner = createAgentRunner({
      db: database.db,
      emit: () => undefined,
      backend,
      log: log.logger,
      sandboxGrants: () => ({
        folders: [
          { path: `${HOME}/notes`, access: FolderAccess.Read },
          { path: `${HOME}/x/../shared/`, access: FolderAccess.ReadWrite },
          { path: `${HOME}/a*`, access: FolderAccess.Read },
        ],
        domains: ['registry.npmjs.org', '*'],
      }),
    })
    runner.send(task.id, 'Read the notes.')
    await settle()
    const session = backend.session

    const usable = {
      folders: [
        { path: `${HOME}/notes`, access: FolderAccess.Read },
        { path: `${HOME}/shared`, access: FolderAccess.ReadWrite },
      ],
      domains: ['registry.npmjs.org'],
    }
    expect(session.options.flagSettings).toEqual(sandboxStartSettings(ROOT))
    expect(session.flagSettings).toEqual([sandboxOverlay(ROOT, PermissionMode.AllowAll, usable)])
    expect(session.flagSettings[0]?.permissions?.allow).toEqual([
      `Read(/${HOME}/notes/**)`,
      'WebFetch(domain:registry.npmjs.org)',
    ])
    expect(log.withMessage('left a grant out of the sandbox').map(({ fields }) => fields)).toEqual([
      { taskId: task.id, value: `${HOME}/a*`, problem: GrantProblem.Pattern },
      { taskId: task.id, value: '*', problem: GrantProblem.NotAHost },
    ])

    // The classifier reads the same grants: the granted folder and domain don't ask, the rejected ones do.
    session.emit(sdk.init())
    await settle()
    const read = await callTool(session, {
      toolUseId: 't1',
      toolName: 'Read',
      input: { file_path: `${HOME}/notes/a.md` },
    })
    const fetch = await callTool(session, {
      toolUseId: 't2',
      toolName: 'WebFetch',
      input: { url: 'https://registry.npmjs.org/x' },
    })
    await expect(read.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    await expect(fetch.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    await callTool(session, { toolUseId: 't3', toolName: 'Read', input: { file_path: `${HOME}/abc/a.md` } })
    await callTool(session, { toolUseId: 't4', toolName: 'WebFetch', input: { url: 'https://example.org/' } })
    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['t3', 't4'])
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

  it('retries in a new session even with background work going on, which ends saying why', async () => {
    const first = await startTurn()
    first.emit(...sdk.backgroundLaunch('toolu_bg', 'af1', 'Survey the tests'))
    await settle()
    await failingCommand(first, 'toolu_01')
    first.emit(sdk.result('Done.'))
    await settle()
    expect(current()).toMatchObject({ activity: TaskActivity.Error, error: { source: TaskErrorSource.Sandbox } })
    expect(toolCall('toolu_bg').state).toBe(ToolCallState.Running)

    await glade.invoke(CommandName.TasksRetry, { id: task.id })
    await settle()

    // Kept, the retry would only replay into the sandbox that failed.
    expect(first.closed).toBe(true)
    expect(backend.sessions).toHaveLength(2)
    expect(toolCall('toolu_bg')).toMatchObject({ state: ToolCallState.Error, output: SANDBOX_RESTARTED_NOTE })
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Run the tests.'])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, error: null })
  })
})
