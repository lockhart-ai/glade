// "Answered permission cards leave the chat" (#459), from the agent's call to what the window shows: the renderer's
// store over the preload's bridge and a fake IPC pair, against the real main-side runner, permission broker and
// repositories, with a scripted agent session asking about its calls as Claude Code does. What the chat and the Tool
// calls list show is worked out from the store as their components do (`chatEntries`, `parentLogRows`,
// `deriveSubagents`), live and after a relaunch (the database reopened under a fresh runner and store).
// Runs in the main Vitest project (Node), since it needs better-sqlite3.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeAgentBackend,
  settle,
  type AskedPermission,
  type PermissionCallFields,
} from '../../main/agent/fake-backend'
import { permissionDeniedMessage, type AgentRunner } from '../../main/agent/runner'
import * as sdk from '../../main/agent/test-sdk-messages'
import { ToolPermissionBehavior } from '../../main/agent/backend'
import { registerBridge } from '../../main/bridge'
import { fakeIpcPair } from '../../main/bridge/fake-ipc'
import { openAppDatabase, type AppDatabase } from '../../main/db/database'
import { updateTask } from '../../main/db/repositories/tasks'
import { sampleTask, sampleWorkspace } from '../../main/db/repositories/test-database'
import { setUiState } from '../../main/db/repositories/ui-state'
import { UNREAD_PLUGINS_FOLDER } from '../../main/plugins/test-plugins'
import { fakeTerminalOptions } from '../../main/terminal/fake-pty'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import {
  PermissionDecisionKind,
  PermissionDestination,
  PermissionMode,
  PermissionRuleBehavior,
  PermissionUpdateType,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type PermissionDecision,
  type Task,
} from '../../shared/domain'
import { ChatEntryKind, chatEntries } from '../chat/chatModel'
import { permissionLineText, type PermissionLines } from '../permissions/permissionLineModel'
import { permissionLinesByToolUse } from '../permissions/permissionLines'
import { deriveSubagents } from '../subagents/subagentsModel'
import { parentLogRows, rowStateLabel, showsResult, type CallRow, type SubagentRow } from '../tool-log/toolLogModel'
import { createGladeStore, type GladeStore } from './store'

let dir: string
let database: AppDatabase
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let store: GladeStore

/** Starts the app on the database in `dir`: a runner, and a window's store hydrated against it. */
async function launch(): Promise<void> {
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
  store = createGladeStore(glade)
  await store.getState().hydrate()
}

/** Quits the app, whatever it's doing, and launches it again on the same database, carrying on what it quit in. */
async function relaunch(): Promise<void> {
  runner.close()
  database.db.close()
  database = openAppDatabase(dir)
  await launch()
  runner.resumeInterrupted()
  await settle()
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  dir = mkdtempSync(join(tmpdir(), 'glade-answered-cards-'))
  database = openAppDatabase(dir)
  const workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
  setUiState(database.db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  await launch()
})

afterEach(() => {
  runner.close()
  database.db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Starts a turn in the ask mode: the session has sent its init, and the turn is running. */
async function startAsking(text = 'Note the retry change, clear the old build and run the tests.'): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  backend.session.emit(sdk.init())
  await settle()
}

/** The agent calls a tool, and Claude Code asks about it, as the SDK does: the `tool_use`, then `canUseTool`. */
async function callTool(fields: PermissionCallFields, parent: string | null = null): Promise<AskedPermission> {
  backend.session.emit(sdk.toolUse(fields.toolUseId, fields.toolName, { ...fields.input }, parent))
  await settle()
  const asked = backend.session.requestPermission(fields)
  await settle()
  return asked
}

/** Answers the open card of a call, as the card's buttons do; the call then gets its result, as the SDK gives it. */
async function answer(asked: AskedPermission, toolUseId: string, decision: PermissionDecision): Promise<void> {
  const request = (store.getState().permissionRequests[task.id] ?? []).find((each) => each.toolUseId === toolUseId)
  await store.getState().answerPermission(request?.id ?? '', decision)
  const verdict = await asked.answer
  const denied = verdict.behavior === ToolPermissionBehavior.Deny
  backend.session.emit(sdk.toolResult(toolUseId, denied ? verdict.message : `Ran ${toolUseId}`, denied))
  await settle()
}

/** The permission cards in the chat, as the chat works its entries out: the tool_use ids of the calls they're about. */
function cardsInChat(): string[] {
  const state = store.getState()
  const current = state.tasks[task.id]
  if (current === undefined) throw new Error('The task is gone')
  return chatEntries(
    current,
    state.messages[task.id] ?? [],
    state.toolEvents[task.id] ?? [],
    state.questionSets[task.id] ?? [],
    state.permissionRequests[task.id] ?? [],
  ).flatMap((entry) => (entry.kind === ChatEntryKind.Permission ? [entry.request.toolUseId] : []))
}

/** A row as the Tool calls list shows it: its call, what its dot says, its permission line, and its result or not. */
function shown(row: CallRow): string {
  const line = row.permission === null ? 'no line' : permissionLineText(row.permission)
  return `${row.call.toolUseId} · ${rowStateLabel(row)} · ${line} · ${showsResult(row) ? 'result' : 'no result'}`
}

function lines(): PermissionLines {
  return permissionLinesByToolUse(store.getState().permissionRequests[task.id] ?? [])
}

/** The Tool calls list's rows, as the tab works them out: the task's own agent's calls. */
function toolCallRows(): string[] {
  return parentLogRows(store.getState().toolEvents[task.id] ?? [], lines()).flatMap((row) =>
    row.kind === ToolEventKind.ToolCall ? [shown(row)] : [],
  )
}

/** The rows of each subagent's log, as its tab of the Agents tab lists them. */
function subagentRows(): string[] {
  const calls = (rows: readonly SubagentRow[]): string[] =>
    rows.flatMap((row) => (row.kind === ToolEventKind.ToolCall ? [shown(row)] : []))
  return deriveSubagents(store.getState().toolEvents[task.id] ?? [], lines()).flatMap(({ log }) =>
    calls(log),
  )
}

const ALLOW_ONCE: PermissionDecision = { kind: PermissionDecisionKind.AllowOnce }
const FOR_TASK: PermissionDecision = { kind: PermissionDecisionKind.AllowForTask }

const EDIT = {
  toolUseId: 'toolu_edit',
  toolName: 'Edit',
  input: { file_path: 'CHANGELOG.md', old_string: '## Unreleased', new_string: '## Unreleased\n\n- Retries.' },
} as const satisfies PermissionCallFields
const CLEAN = {
  toolUseId: 'toolu_clean',
  toolName: 'Bash',
  input: { command: 'rm -rf dist', description: 'Clear the old build' },
} as const satisfies PermissionCallFields
const TEST = {
  toolUseId: 'toolu_test',
  toolName: 'Bash',
  input: { command: 'npm test -- --coverage', description: 'Run the tests' },
  suggestions: [
    {
      type: PermissionUpdateType.AddRules,
      rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      behavior: PermissionRuleBehavior.Allow,
      destination: PermissionDestination.LocalSettings,
    },
  ],
} as const satisfies PermissionCallFields

describe('several cards on one turn', () => {
  it('each leaves the chat as it is answered, in whatever order, and its row says what was decided', async () => {
    await startAsking()
    const edit = await callTool(EDIT)
    const clean = await callTool(CLEAN)
    const test = await callTool(TEST)

    // All three wait: three cards in the chat, three purple rows with no result yet.
    expect(cardsInChat()).toEqual(['toolu_edit', 'toolu_clean', 'toolu_test'])
    expect(toolCallRows()).toEqual([
      'toolu_edit · Waiting · Waiting on you · no result',
      'toolu_clean · Waiting · Waiting on you · no result',
      'toolu_test · Waiting · Waiting on you · no result',
    ])

    // The last first, for the task: it names the rule it granted.
    await answer(test, 'toolu_test', FOR_TASK)
    expect(cardsInChat()).toEqual(['toolu_edit', 'toolu_clean'])
    expect(toolCallRows()).toEqual([
      'toolu_edit · Waiting · Waiting on you · no result',
      'toolu_clean · Waiting · Waiting on you · no result',
      'toolu_test · Done · Allowed for this task: npm test commands · result',
    ])

    // Then the middle one, denied with a note: the call failed, and its line says why in place of a result.
    await answer(clean, 'toolu_clean', {
      kind: PermissionDecisionKind.Deny,
      note: 'Keep dist, the smoke test reads it.',
    })
    expect(cardsInChat()).toEqual(['toolu_edit'])
    expect(toolCallRows()).toEqual([
      'toolu_edit · Waiting · Waiting on you · no result',
      'toolu_clean · Failed · Denied: “Keep dist, the smoke test reads it.” · no result',
      'toolu_test · Done · Allowed for this task: npm test commands · result',
    ])
    expect(store.getState().toolEvents[task.id]).toContainEqual(
      expect.objectContaining({
        toolUseId: 'toolu_clean',
        output: permissionDeniedMessage('Keep dist, the smoke test reads it.'),
      }),
    )

    // Then the first, once: the chat is your message alone.
    await answer(edit, 'toolu_edit', ALLOW_ONCE)
    expect(cardsInChat()).toEqual([])
    const settled = [
      'toolu_edit · Done · Allowed once · result',
      'toolu_clean · Failed · Denied: “Keep dist, the smoke test reads it.” · no result',
      'toolu_test · Done · Allowed for this task: npm test commands · result',
    ]
    expect(toolCallRows()).toEqual(settled)

    // After a relaunch they're still out of the chat, and still on their rows.
    backend.session.emit(sdk.text('Done.', null, 'msg_02'), sdk.result('Done.'))
    await settle()
    await relaunch()
    expect(cardsInChat()).toEqual([])
    expect(toolCallRows()).toEqual(settled)
  })

  it('a denial without a note says Denied alone', async () => {
    await startAsking()
    const clean = await callTool(CLEAN)

    await answer(clean, 'toolu_clean', { kind: PermissionDecisionKind.Deny })

    expect(cardsInChat()).toEqual([])
    expect(toolCallRows()).toEqual(['toolu_clean · Failed · Denied · no result'])
  })

  it('a call a task rule lets through later has no card, and no line of its own', async () => {
    await startAsking()
    const test = await callTool(TEST)
    await answer(test, 'toolu_test', FOR_TASK)

    // The SDK doesn't ask about a call the rule covers: its tool_use and result just arrive.
    backend.session.emit(
      sdk.toolUse('toolu_watch', 'Bash', { command: 'npm test -- --watch' }),
      sdk.toolResult('toolu_watch', 'Watching'),
    )
    await settle()

    expect(cardsInChat()).toEqual([])
    expect(toolCallRows()).toEqual([
      'toolu_test · Done · Allowed for this task: npm test commands · result',
      'toolu_watch · Done · no line · result',
    ])
  })
})

describe('a card withdrawn by Stop', () => {
  it('leaves the chat with the others open, and every row says Withdrawn, after a relaunch too', async () => {
    await startAsking()
    const edit = await callTool(EDIT)
    await answer(edit, 'toolu_edit', ALLOW_ONCE)
    const clean = await callTool(CLEAN)
    const test = await callTool(TEST)
    expect(cardsInChat()).toEqual(['toolu_clean', 'toolu_test'])
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.interruptMarker(true), sdk.abortedResult('aborted_tools'))
      return Promise.resolve()
    }

    await store.getState().stopTask(task.id)
    await settle()

    await expect(clean.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny })
    await expect(test.answer).resolves.toMatchObject({ behavior: ToolPermissionBehavior.Deny })
    expect(cardsInChat()).toEqual([])
    const stopped = [
      'toolu_edit · Done · Allowed once · result',
      'toolu_clean · Withdrawn · Withdrawn · no result',
      'toolu_test · Withdrawn · Withdrawn · no result',
    ]
    expect(toolCallRows()).toEqual(stopped)

    await relaunch()
    expect(cardsInChat()).toEqual([])
    expect(toolCallRows()).toEqual(stopped)
  })
})

describe('a card open when the app quits', () => {
  it('is in the chat after the relaunch, its row still waiting; answered, it leaves, and the row says so', async () => {
    await startAsking()
    await callTool(EDIT)
    await callTool(CLEAN)

    await relaunch()

    // The calls ended when the app quit, so their dots are their own; their lines say they still wait on you.
    expect(cardsInChat()).toEqual(['toolu_edit', 'toolu_clean'])
    expect(toolCallRows()).toEqual([
      'toolu_edit · Interrupted · Waiting on you · no result',
      'toolu_clean · Interrupted · Waiting on you · no result',
    ])

    // Answer the second first: nothing reaches the agent until both are decided.
    const [editRequest, cleanRequest] = store.getState().permissionRequests[task.id] ?? []
    await store
      .getState()
      .answerPermission(cleanRequest?.id ?? '', { kind: PermissionDecisionKind.Deny, note: 'Not yet' })
    await settle()
    expect(cardsInChat()).toEqual(['toolu_edit'])
    expect(toolCallRows()).toEqual([
      'toolu_edit · Interrupted · Waiting on you · no result',
      'toolu_clean · Interrupted · Denied: “Not yet” · no result',
    ])
    expect(backend.sessions).toHaveLength(0)

    await store.getState().answerPermission(editRequest?.id ?? '', ALLOW_ONCE)
    await settle()
    expect(cardsInChat()).toEqual([])
    expect(toolCallRows()).toEqual([
      'toolu_edit · Interrupted · Allowed once · result',
      'toolu_clean · Interrupted · Denied: “Not yet” · no result',
    ])
    // The decisions went to the agent in a message, in a session resumed for them.
    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.sent.at(-1)?.text).toContain('Not yet')

    // And a second relaunch changes nothing of it.
    backend.session.emit(sdk.init(), sdk.text('Carried on.'), sdk.result('Carried on.'))
    await settle()
    await relaunch()
    expect(cardsInChat()).toEqual([])
    expect(toolCallRows()).toEqual([
      'toolu_edit · Interrupted · Allowed once · result',
      'toolu_clean · Interrupted · Denied: “Not yet” · no result',
    ])
  })
})

describe("a subagent's request", () => {
  it("shows on the row its call already has in the subagent's log, not in the Tool calls list", async () => {
    await startAsking('Write the upgrade guide.')
    backend.session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Upgrade guide', prompt: 'Write it.' }))
    await settle()
    const write = await callTool(
      {
        toolUseId: 'toolu_write',
        toolName: 'Write',
        input: { file_path: 'docs/upgrade.md', content: '# Upgrading' },
        agentId: 'a1b2c3',
      },
      'toolu_agent',
    )
    const clean = await callTool({ ...CLEAN, agentId: 'a1b2c3' }, 'toolu_agent')

    // Both cards are in the chat; the Tool calls list has the Agent call alone, with no line of its own.
    expect(cardsInChat()).toEqual(['toolu_write', 'toolu_clean'])
    expect(toolCallRows()).toEqual(['toolu_agent · Running · no line · result'])
    expect(subagentRows()).toEqual([
      'toolu_write · Waiting · Waiting on you · no result',
      'toolu_clean · Waiting · Waiting on you · no result',
    ])

    await store
      .getState()
      .answerPermission(
        (store.getState().permissionRequests[task.id] ?? []).find((each) => each.toolUseId === 'toolu_clean')?.id ?? '',
        { kind: PermissionDecisionKind.Deny, note: 'Leave the build' },
      )
    const refused = await clean.answer
    backend.session.emit(
      sdk.toolResult(
        'toolu_clean',
        refused.behavior === ToolPermissionBehavior.Deny ? refused.message : '',
        true,
        'toolu_agent',
      ),
    )
    await settle()
    expect(cardsInChat()).toEqual(['toolu_write'])

    await store
      .getState()
      .answerPermission(
        (store.getState().permissionRequests[task.id] ?? []).find((each) => each.toolUseId === 'toolu_write')?.id ?? '',
        ALLOW_ONCE,
      )
    await write.answer
    backend.session.emit(sdk.toolResult('toolu_write', 'File created successfully', false, 'toolu_agent'))
    await settle()

    expect(cardsInChat()).toEqual([])
    const decided = [
      'toolu_write · Done · Allowed once · result',
      'toolu_clean · Failed · Denied: “Leave the build” · no result',
    ]
    expect(subagentRows()).toEqual(decided)
    expect(toolCallRows()).toEqual(['toolu_agent · Running · no line · result'])
    expect(store.getState().toolEvents[task.id]).toContainEqual(
      expect.objectContaining({ toolUseId: 'toolu_write', state: ToolCallState.Done }),
    )

    backend.session.emit(
      sdk.toolResult('toolu_agent', 'The guide is written.'),
      sdk.text('Done.', null, 'msg_02'),
      sdk.result('Done.'),
    )
    await settle()
    await relaunch()
    expect(cardsInChat()).toEqual([])
    expect(subagentRows()).toEqual(decided)
  })
})
