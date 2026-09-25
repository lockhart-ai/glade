// An imported session carries on in Glade: the next message resumes its Claude Code session in the workspace root, and
// its turns are numbered after the imported ones. The real bridge and runner, with the fake agent backend.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createBridge } from '../../../preload/bridge'
import { CommandName, type GladeBridge } from '../../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolEventKind,
  type Workspace,
} from '../../../shared/domain'
import { FakeAgentBackend, settle } from '../../agent/fake-backend'
import type { AgentRunner } from '../../agent/runner'
import * as sdk from '../../agent/test-sdk-messages'
import { registerBridge } from '../../bridge'
import { fakeIpcPair } from '../../bridge/fake-ipc'
import { listMessages } from '../../db/repositories/messages'
import { getTask } from '../../db/repositories/tasks'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from '../../db/repositories/test-database'
import { listToolEvents } from '../../db/repositories/tool-events'
import { UNREAD_PLUGINS_FOLDER } from '../../plugins/test-plugins'
import { fakeTerminalOptions } from '../../terminal/fake-pty'
import { createClaudeCodeSessions, type ClaudeCodeSessions } from './service'
import { plainChat, SESSION_ID, writeTranscript } from './test-transcripts'

let database: TestDatabase
let root: string
let workspace: Workspace
let backend: FakeAgentBackend
let runner: AgentRunner
let glade: GladeBridge
let sessions: ClaudeCodeSessions

beforeEach(() => {
  database = openTestDatabase()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-import-resume-')))
  const cwd = join(root, 'acme-api')
  mkdirSync(cwd)
  workspace = sampleWorkspace(database.db, cwd)
  writeTranscript(join(root, 'projects'), cwd, plainChat(cwd).toJsonl())
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
  sessions = createClaudeCodeSessions({
    db: database.db,
    emit: () => undefined,
    projectsDir: join(root, 'projects'),
  })
})

afterEach(() => {
  runner.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
})

it('resumes the imported session in the workspace root, reopening the task, with the next turn after the imported ones', async () => {
  const { task } = await sessions.import({
    session: { sessionId: SESSION_ID },
    state: TaskState.Done,
    createWorkspace: false,
  })
  expect(backend.sessions).toHaveLength(0)

  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Now pin the zone in CI too.' })
  await settle()

  expect(backend.sessions).toHaveLength(1)
  expect(backend.session.options).toMatchObject({ resumeSessionId: SESSION_ID, cwd: workspace.rootPath })
  expect(backend.session.sent.map((message) => message.text)).toEqual(['Now pin the zone in CI too.'])
  expect(getTask(database.db, task.id)).toMatchObject({ state: TaskState.Active, activity: TaskActivity.Working })

  // The session carries on under the same id, and the turn ends as any other.
  backend.session.emit(
    sdk.init(SESSION_ID),
    sdk.text('Pinned it in the CI config.'),
    sdk.result('Pinned it in the CI config.'),
  )
  await settle()

  const messages = listMessages(database.db, task.id)
  expect(messages.map((message) => [message.role, message.turn])).toEqual([
    [MessageRole.User, 1],
    [MessageRole.Agent, 1],
    [MessageRole.User, 2],
    [MessageRole.Agent, 2],
    [MessageRole.User, 3],
    [MessageRole.Agent, 3],
  ])
  const dividers = listToolEvents(database.db, task.id).flatMap((event) =>
    event.kind === ToolEventKind.Divider ? [[event.dividerKind, event.turn]] : [],
  )
  expect(dividers).toEqual([
    [DividerKind.Turn, 1],
    [DividerKind.Turn, 2],
    [DividerKind.MarkedDone, 2],
    [DividerKind.Reopened, 3],
    [DividerKind.Turn, 3],
  ])
  expect(getTask(database.db, task.id)).toMatchObject({ sessionId: SESSION_ID, activity: TaskActivity.Waiting })
})
