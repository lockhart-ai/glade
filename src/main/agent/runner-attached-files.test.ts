// Files attached to messages (#396), end to end: dropped files copied into a real workspace folder through the bridge,
// then sent, queued, drafted, relaunched and deleted, with a scripted agent session behind the real runner.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import { AttachedFileKind, attachedFileLine, type AttachedFile } from '../../shared/attachedFiles'
import { MessageRole, QuestionKind, UiStateKey, type Message, type Task } from '../../shared/domain'
import { PNG } from '../../shared/test-images'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { getOpenQuestionSet } from '../db/repositories/question-sets'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { FakeAgentBackend, settle } from './fake-backend'
import type { AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let folder: string
let root: string
let desktop: string
let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner

function start(): void {
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
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'glade-attached-')))
  root = join(folder, 'acme-api')
  desktop = join(folder, 'Desktop')
  mkdirSync(root)
  mkdirSync(desktop)
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db, root).id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  start()
})

afterEach(() => {
  runner.close()
  database.close()
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** Drops a made-up file from the Desktop onto the input bar: main copies it into the workspace. */
async function attach(name: string, contents: string | Buffer = 'region,total\nnorth,120\n'): Promise<AttachedFile> {
  const path = join(desktop, name)
  writeFileSync(path, contents)
  return (await glade.invoke(CommandName.AttachmentsAdd, { taskId: task.id, path })).file
}

async function sendWith(text: string, files: readonly AttachedFile[]): Promise<Message> {
  return (await glade.invoke(CommandName.TasksSend, { id: task.id, text, files })).message
}

/** What the session was sent: each message's text and images. */
function sent(): unknown[] {
  return backend.session.sent.map(({ text, images }) => ({ text, images }))
}

function line(file: AttachedFile): string {
  return attachedFileLine(file, root)
}

describe('attached files', () => {
  it('saves a message’s files with it and hands the agent a line with each path, in order, at the end', async () => {
    const sales = await attach('sales.csv')
    const policy = await attach('policy.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]))

    const message = await sendWith('Check these against the manifest.', [sales, policy])

    expect(message.files).toEqual([sales, policy])
    expect(listMessages(database.db, task.id)).toEqual([message])
    // The stored, user-visible body is only what you typed: the lines are for the agent.
    expect(message.body).toBe('Check these against the manifest.')
    expect(sent()).toEqual([
      { text: `Check these against the manifest.\n\n${line(sales)}\n${line(policy)}`, images: [] },
    ])
    expect(line(sales)).toBe(
      `Attached file: sales.csv (23 bytes) at .glade/attachments/${task.id}/sales.csv (absolute path: ${root}/.glade/attachments/${task.id}/sales.csv)`,
    )
  })

  it('sends a message that is only files', async () => {
    const sales = await attach('sales.csv')
    const message = await sendWith('', [sales])
    expect(message).toMatchObject({ body: '', files: [sales] })
    expect(sent()).toEqual([{ text: line(sales), images: [] }])
  })

  it('hands an attached image to the agent as an image too, after any pasted ones, with its path line', async () => {
    const chart = await attach('chart.png', Buffer.from(PNG.data, 'base64'))
    expect(chart.kind).toBe(AttachedFileKind.Image)

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Like these', images: [PNG], files: [chart] })

    expect(sent()).toEqual([{ text: `Like these\n\n${line(chart)}`, images: [PNG, PNG] }])
  })

  it('leaves an image whose copy is gone to its path line alone', async () => {
    const chart = await attach('chart.png', Buffer.from(PNG.data, 'base64'))
    rmSync(join(root, chart.path))
    await sendWith('', [chart])
    expect(sent()).toEqual([{ text: line(chart), images: [] }])
  })

  it('keeps a queued message’s files while it waits, and hands them over with it when the step finishes', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the existing uploads to S3.' })
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'python scripts/copy.py' }))
    await settle()
    const log = await attach('copy-errors.log', 'failed: a7f3.jpg\n')

    const { queuedMessage } = await glade.invoke(CommandName.QueueAdd, {
      taskId: task.id,
      text: 'Here’s the log.',
      files: [log],
    })
    expect(queuedMessage.files).toEqual([log])
    expect(listQueuedMessages(database.db, task.id)).toEqual([queuedMessage])

    // Kept across a relaunch, still queued.
    runner.close()
    start()
    expect(listQueuedMessages(database.db, task.id)).toEqual([queuedMessage])
  })

  it('delivers queued files with the queue, in the same form', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Copy the existing uploads to S3.' })
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'python scripts/copy.py' }))
    await settle()
    const log = await attach('copy-errors.log', 'failed: a7f3.jpg\n')
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: '', files: [log] })

    backend.session.emit(sdk.toolResult('toolu_01', 'copied'))
    await settle()

    expect(sent().at(-1)).toEqual({ text: line(log), images: [] })
    expect(listMessages(database.db, task.id).at(-1)?.files).toEqual([log])
  })

  it('shows the files after a relaunch, and hands them to a new session when the old one never started', async () => {
    const sales = await attach('sales.csv')
    const message = await sendWith('Check this.', [sales])
    runner.close()
    start()

    expect(listMessages(database.db, task.id)).toEqual([message])
    runner.resumeInterrupted()
    expect(sent()).toEqual([{ text: `Check this.\n\n${line(sales)}`, images: [] }])
  })

  it('keeps a draft’s files across a relaunch', async () => {
    const sales = await attach('sales.csv')
    await glade.invoke(CommandName.DraftsSet, { taskId: task.id, text: 'Half a thought', files: [sales] })
    runner.close()
    start()
    expect(await glade.invoke(CommandName.DraftsGet, { taskId: task.id })).toEqual({
      draft: { text: 'Half a thought', images: [], pastedBlocks: [], files: [sales] },
    })
  })

  it('refuses files with an answer to the agent’s questions, keeping the questions open', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Draft the release notes for 2.4.' })
    backend.session.emit(sdk.init())
    void backend.session
      .callTool('toolu_ask', 'mcp__glade__ask', { questions: [{ kind: QuestionKind.Text, prompt: 'Anything else?' }] })
      .catch(() => undefined)
    await vi.waitFor(() => {
      if (getOpenQuestionSet(database.db, task.id) === undefined) throw new Error('No question is open yet')
    })

    await expect(sendWith('Like this.', [await attach('sales.csv')])).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    expect(getOpenQuestionSet(database.db, task.id)).toBeDefined()
    expect(listMessages(database.db, task.id).map(({ role, body }) => ({ role, body }))).toEqual([
      { role: MessageRole.User, body: 'Draft the release notes for 2.4.' },
    ])
  })

  it('refuses another task’s file', async () => {
    const other = sampleTask(database.db, task.workspaceId)
    writeFileSync(join(desktop, 'theirs.csv'), 'x')
    const { file: theirs } = await glade.invoke(CommandName.AttachmentsAdd, {
      taskId: other.id,
      path: join(desktop, 'theirs.csv'),
    })
    await expect(sendWith('Mine?', [theirs])).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
  })

  it('discards a file taken off the draft, through the bridge, and keeps one that was sent', async () => {
    const dropped = await attach('dropped.csv')
    const sales = await attach('sales.csv')
    await sendWith('Sent', [sales])

    await glade.invoke(CommandName.AttachmentsDiscard, { taskId: task.id, path: dropped.path })
    await glade.invoke(CommandName.AttachmentsDiscard, { taskId: task.id, path: sales.path })

    expect(existsSync(join(root, dropped.path))).toBe(false)
    expect(readFileSync(join(root, sales.path), 'utf8')).toBe('region,total\nnorth,120\n')
  })

  it('refuses a folder through the bridge, saying so in words fit for a toast', async () => {
    mkdirSync(join(desktop, 'reports'))
    await expect(
      glade.invoke(CommandName.AttachmentsAdd, { taskId: task.id, path: join(desktop, 'reports') }),
    ).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
      message: 'attachments.add: reports is a folder: only files can be attached for now.',
    })
  })

  it('deletes the task’s attached files with the task, and a done task keeps them', async () => {
    const sales = await attach('sales.csv')
    await sendWith('Check this.', [sales])
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })
    expect(existsSync(join(root, sales.path))).toBe(true)

    await glade.invoke(CommandName.TasksDelete, { id: task.id })

    expect(existsSync(join(root, `.glade/attachments/${task.id}`))).toBe(false)
    expect(existsSync(join(root, '.glade/attachments'))).toBe(true)
  })
})
