// A session that started before the agent sandbox was on, and resumes in it (#452): Claude Code keeps its old prompt,
// which says nothing of the sandbox or of asking with `request_access`, so Glade tells it once, in a block ahead of
// its next message (`./session-context`). A fake agent session behind the real bridge, saving to a database in a
// temporary folder, with a home folder of the tests' own.
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import { MessageRole, UiStateKey, type Task, type Workspace } from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { setHandoff } from '../db/repositories/backfills'
import { listMessages } from '../db/repositories/messages'
import { getSessionContext, setSessionContext } from '../db/repositories/session-context'
import { updateSettings } from '../db/repositories/settings'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle } from './fake-backend'
import { RESUME_PROMPT, type AgentRunner } from './runner'
import { handoffSection, INSTRUCTION_UPDATES, SANDBOX_LINE, systemPromptAppend } from './system-prompt'
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

const ROOT = `${homedir()}/src/acme-api`
const SANDBOX_BLOCK = `[Glade: this session now runs in a sandbox]\n${SANDBOX_LINE}\n[end]`

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

/** Quits and reopens Glade, with the sandbox switched as given: a task's next session reads the setting. */
function relaunch(sandboxEnabled: boolean): void {
  runner.close()
  updateSettings(database.db, { sandboxEnabled })
  launch()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  database = openTestDatabase()
  updateSettings(database.db, { sandboxEnabled: false })
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

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  await settle()
}

/** Ends the running turn with a reply, and lets the runner handle it. */
async function reply(text = 'Done.'): Promise<void> {
  backend.session.emit(sdk.init(), sdk.result(text))
  await settle()
}

/** What the latest session was sent, in order. */
function sentTexts(): string[] {
  return backend.session.sent.map(({ text }) => text)
}

function sandboxed(): boolean {
  return backend.session.options.flagSettings?.sandbox?.enabled === true
}

/** Whether the task's session is recorded as told of the sandbox. */
function told(): boolean | undefined {
  return getSessionContext(database.db, task.id)?.sandbox
}

describe('a session that started before the sandbox was on', () => {
  it('is told of the sandbox once, ahead of its next message, when it resumes in it', async () => {
    await send('Why is the login test flaky?')
    await reply()
    expect(backend.session.options.systemPromptAppend).not.toContain(SANDBOX_LINE)
    expect(told()).toBe(false)

    relaunch(true)
    await send('And the logout test?')
    await reply()
    await send('And the signup test?')

    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(sandboxed()).toBe(true)
    expect(sentTexts()).toEqual([`${SANDBOX_BLOCK}\n\nAnd the logout test?`, 'And the signup test?'])
    expect(told()).toBe(true)
    // The chat keeps only what you wrote.
    expect(listMessages(database.db, task.id).map(({ role, body }) => ({ role, body }))).toEqual([
      { role: MessageRole.User, body: 'Why is the login test flaky?' },
      { role: MessageRole.Agent, body: 'Done.' },
      { role: MessageRole.User, body: 'And the logout test?' },
      { role: MessageRole.Agent, body: 'Done.' },
      { role: MessageRole.User, body: 'And the signup test?' },
    ])
  })

  it('is told what the prompt of a session started in the sandbox says, naming request_access', () => {
    expect(systemPromptAppend(task, undefined, false, null, true)).toContain(SANDBOX_LINE)
    expect(SANDBOX_BLOCK).toContain('call request_access with the absolute path')
    expect(SANDBOX_BLOCK).toContain('Operation not permitted')
  })

  it('is not told again after another relaunch, nor when its session is resumed again', async () => {
    await send('Why is the login test flaky?')
    await reply()
    relaunch(true)
    await send('And the logout test?')
    await reply()

    relaunch(true)
    await send('And the signup test?')
    expect(sentTexts()).toEqual(['And the signup test?'])
    await reply()
    backend.session.end()
    await settle()
    await send('And the settings test?')

    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(sentTexts()).toEqual(['And the settings test?'])
  })

  it('is not told while it still runs outside the sandbox, only once its session restarts in it', async () => {
    await send('Why is the login test flaky?')
    await reply()

    // Turned on in Settings while the session runs: it keeps what it started with.
    updateSettings(database.db, { sandboxEnabled: true })
    await send('And the logout test?')
    expect(backend.sessions).toHaveLength(1)
    expect(sandboxed()).toBe(false)
    expect(sentTexts()).toEqual(['Why is the login test flaky?', 'And the logout test?'])
    expect(told()).toBe(false)
    await reply()

    backend.session.end()
    await settle()
    await send('And the signup test?')

    expect(backend.sessions).toHaveLength(2)
    expect(sandboxed()).toBe(true)
    expect(sentTexts()).toEqual([`${SANDBOX_BLOCK}\n\nAnd the signup test?`])
  })

  it('is never told when it resumes with the sandbox still off', async () => {
    await send('Why is the login test flaky?')
    await reply()

    relaunch(false)
    await send('And the logout test?')

    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(sentTexts()).toEqual(['And the logout test?'])
    expect(told()).toBe(false)
  })

  it('is neither told nor skipped by a relaunch mid-turn, which carries the turn on without the block', async () => {
    await send('Why is the login test flaky?')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }))
    await settle()

    relaunch(true)
    runner.resumeInterrupted()
    await settle()
    expect(sandboxed()).toBe(true)
    expect(sentTexts()).toEqual([RESUME_PROMPT])
    expect(told()).toBe(false)

    await reply()
    await send('And the logout test?')
    expect(sentTexts()).toEqual([RESUME_PROMPT, `${SANDBOX_BLOCK}\n\nAnd the logout test?`])
    expect(told()).toBe(true)
  })

  it("goes with the message that starts the turn, and not with the queue's that follow in it", async () => {
    await send('Why is the login test flaky?')
    await reply()
    relaunch(true)
    await send('And the logout test?')
    backend.session.emit(sdk.init())
    await settle()
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'Then the signup test.' })
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'And the settings test.' })
    await reply()

    expect(sentTexts()).toEqual([
      `${SANDBOX_BLOCK}\n\nAnd the logout test?`,
      'Then the signup test.',
      'And the settings test.',
    ])
  })

  it('goes after the instructions added since and before a new handoff note, in one message', async () => {
    database.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('old-session', task.id)
    setSessionContext(database.db, task.id, {
      instructions: true,
      instructionUpdates: 0,
      handoffAt: null,
      sandbox: false,
      todoHub: false,
    })
    const handoff = setHandoff(database.db, task.id, '## Next\n\nShip it.', 5_000)
    if (handoff === undefined) throw new Error('No handoff')
    relaunch(true)

    await send('Carry on.')

    expect(sentTexts()).toEqual([
      [
        `[Glade: new instructions for this session]\n${INSTRUCTION_UPDATES.join('\n\n')}\n[end]`,
        SANDBOX_BLOCK,
        `[Glade: handoff for this task]\n${handoffSection(handoff)}\n[end]`,
        'Carry on.',
      ].join('\n\n'),
    ])
    expect(getSessionContext(database.db, task.id)).toEqual({
      instructions: true,
      instructionUpdates: INSTRUCTION_UPDATES.length,
      handoffAt: 5_000,
      sandbox: true,
      todoHub: false,
    })
  })

  it('from before anything was recorded for it is told too', async () => {
    database.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('old-session', task.id)
    relaunch(true)

    await send('Carry on.')

    expect(sentTexts()[0]).toContain(SANDBOX_BLOCK)
    expect(told()).toBe(true)
  })
})

describe('a session that knows of the sandbox already', () => {
  it('started in it by Glade, has it in its prompt and is sent nothing', async () => {
    relaunch(true)
    await send('Why is the login test flaky?')
    await reply()
    await send('And the logout test?')

    expect(backend.session.options.systemPromptAppend).toContain(SANDBOX_LINE)
    expect(sentTexts()).toEqual(['Why is the login test flaky?', 'And the logout test?'])
    expect(told()).toBe(true)

    relaunch(true)
    await send('And the signup test?')
    expect(sentTexts()).toEqual(['And the signup test?'])
  })

  it('resumed with the sandbox off and then on again, is not told a second time', async () => {
    relaunch(true)
    await send('Why is the login test flaky?')
    await reply()

    relaunch(false)
    await send('And the logout test?')
    expect(sandboxed()).toBe(false)
    expect(sentTexts()).toEqual(['And the logout test?'])
    await reply()

    relaunch(true)
    await send('And the signup test?')
    expect(sandboxed()).toBe(true)
    expect(sentTexts()).toEqual(['And the signup test?'])
  })

  it("imported from Claude Code, gets it in Glade's whole prompt, not in a block of its own", async () => {
    database.db.prepare('UPDATE tasks SET imported_at = 1, session_id = ? WHERE id = ?').run('cli-session', task.id)
    relaunch(true)
    const imported = getTask(database.db, task.id)
    if (imported === undefined) throw new Error('The task is gone')

    await send('Carry on where we left off.')
    await reply()
    await send('And the logout test.')

    const prompt = systemPromptAppend(imported, undefined, false, null, true)
    expect(prompt).toContain(SANDBOX_LINE)
    expect(sentTexts()).toEqual([
      `[Glade: instructions for this session]\n${prompt}\n[end]\n\nCarry on where we left off.`,
      'And the logout test.',
    ])
    expect(told()).toBe(true)
  })

  it('imported with the sandbox off, is told when it later resumes in the sandbox', async () => {
    database.db.prepare('UPDATE tasks SET imported_at = 1, session_id = ? WHERE id = ?').run('cli-session', task.id)
    await send('Carry on where we left off.')
    await reply()
    expect(sentTexts()[0]).not.toContain(SANDBOX_LINE)
    expect(told()).toBe(false)

    relaunch(true)
    await send('And the logout test.')

    expect(sentTexts()).toEqual([`${SANDBOX_BLOCK}\n\nAnd the logout test.`])
  })
})
