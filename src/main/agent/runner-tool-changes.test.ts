// A session resumed across an update can keep Claude Code's own stale view of one of Glade's tools, even though its
// calls reach the live, current server (#709): Glade tells it once, in a block ahead of its next message, naming
// the tool and its current description, the same way #708's instruction updates are (`./session-context`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import { type Task, type Workspace } from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { getToolFingerprints, setToolFingerprints } from '../db/repositories/session-tool-fingerprints'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { DESCRIPTIONS, GLADE_TOOL_SIGNATURES, GladeTool } from './glade-tools'
import { FakeAgentBackend, settle } from './fake-backend'
import { startedContext } from './session-context'
import { setSessionContext } from '../db/repositories/session-context'
import { type AgentRunner } from './runner'
import { toolFingerprint } from './tool-fingerprint'
import * as sdk from './test-sdk-messages'

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
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  await settle()
}

async function reply(text = 'Done.'): Promise<void> {
  backend.session.emit(sdk.init(), sdk.result(text))
  await settle()
}

function sentTexts(): string[] {
  return backend.session.sent.map(({ text }) => text)
}

/** Leaves the task with a session Glade already started, caught up on everything #708 covers. */
function startedFullyCaughtUp(): void {
  database.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('old-session', task.id)
  setSessionContext(database.db, task.id, startedContext(null, false, null))
}

const UPDATE_TODO_NAME: string = GladeTool.UpdateTodo
const updateTodoSignature = GLADE_TOOL_SIGNATURES.find(({ name }) => name === UPDATE_TODO_NAME)
if (updateTodoSignature === undefined) throw new Error('update_todo not in GLADE_TOOL_SIGNATURES')
const UPDATE_TODO_FINGERPRINT = toolFingerprint(updateTodoSignature)

describe("a tool of Glade's own that changed since the session last saw it (#709)", () => {
  it("goes ahead of the next message, naming the tool and its current description, and isn't sent again", async () => {
    startedFullyCaughtUp()
    setToolFingerprints(database.db, task.id, new Map([[GladeTool.UpdateTodo, 'a stale fingerprint']]))

    await send('How are the todos looking?')

    expect(sentTexts()).toEqual([
      `[Glade: a tool changed since this session last saw it]\n\`${UPDATE_TODO_NAME}\` now: ` +
        `${DESCRIPTIONS[GladeTool.UpdateTodo]}\n[end]\n\nHow are the todos looking?`,
    ])
    // Recorded as told: its current fingerprint, not the stale one.
    expect(getToolFingerprints(database.db, task.id).get(UPDATE_TODO_NAME)).toBe(UPDATE_TODO_FINGERPRINT)

    await reply()
    await send('Anything else?')
    expect(sentTexts()).toEqual([expect.any(String) as unknown, 'Anything else?'])
  })

  it('says nothing of a tool recorded with its current fingerprint already', async () => {
    startedFullyCaughtUp()
    setToolFingerprints(database.db, task.id, new Map([[UPDATE_TODO_NAME, UPDATE_TODO_FINGERPRINT]]))

    await send('Carry on.')

    expect(sentTexts()).toEqual(['Carry on.'])
  })

  it("records every tool's fingerprint silently on a session's first turn: nothing was stale to begin with", async () => {
    await send('Why is the login test flaky?')

    expect(sentTexts()).toEqual(['Why is the login test flaky?'])
    expect(getToolFingerprints(database.db, task.id).get(UPDATE_TODO_NAME)).toBe(UPDATE_TODO_FINGERPRINT)
  })
})
