// The commits a task makes, through the runner (#275): its session's `PreToolUse` hook and its `Bash` calls' results
// reach the change tracker, a subagent's and a background subagent's too, and the commits reach the window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import type { Task } from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import type { BashEnd, BashStart, ChangeTracker } from '../changes/tracker'
import { createChangeTracker } from '../changes/tracker'
import { listTaskCommits } from '../db/repositories/task-commits'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createGit } from '../git/git'
import { openTestRepos, TEST_GIT_RUN, type TestRepos } from '../git/test-repos'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { FakeAgentBackend, settle } from './fake-backend'
import { createAgentRunner, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let runner: AgentRunner

/** A tracker that only records what it's told. */
interface RecordingTracker extends ChangeTracker {
  readonly started: [string, BashStart][]
  readonly finished: [string, BashEnd][]
  readonly ended: string[]
}

function recordingTracker(): RecordingTracker {
  const started: [string, BashStart][] = []
  const finished: [string, BashEnd][] = []
  const ended: string[] = []
  return {
    started,
    finished,
    ended,
    bashStarting: (taskId, call) => {
      started.push([taskId, call])
      return Promise.resolve()
    },
    bashFinished: (taskId, call) => {
      finished.push([taskId, call])
      return Promise.resolve()
    },
    sessionEnded: (taskId) => {
      ended.push(taskId)
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  backend = new FakeAgentBackend()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

describe('what the runner tells the change tracker', () => {
  let tracker: RecordingTracker

  beforeEach(async () => {
    tracker = recordingTracker()
    runner = createAgentRunner({ db: database.db, emit: () => undefined, backend, changes: tracker })
    runner.send(task.id, 'Fix the test and commit it.')
    await settle()
  })

  it('each Bash call about to run, and each one’s result, its own agent’s and a subagent’s, failed or not', async () => {
    await backend.session.startBash({ toolUseId: 'toolu_1', cwd: '/code/acme-api', command: 'git commit -am Fix' })
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_1', 'Bash', { command: 'git commit -am Fix', description: 'Commit' }),
      sdk.toolResult('toolu_1', '[main a1b2c3d] Fix'),
      sdk.toolUse('toolu_agent', 'Agent', { description: 'Update the docs', prompt: 'Do it.' }, null, 'msg_02'),
      sdk.toolUse('toolu_2', 'Bash', { command: 'npm test && git commit -m Docs' }, 'toolu_agent', 'msg_03'),
      sdk.toolResult('toolu_2', 'FAIL test/date.test.ts', true, 'toolu_agent'),
      sdk.toolUse('toolu_read', 'Read', { file_path: 'README.md' }, 'toolu_agent', 'msg_04'),
      sdk.toolResult('toolu_read', '# Acme API', false, 'toolu_agent'),
      sdk.toolUse('toolu_odd', 'Bash', { description: 'No command' }, null, 'msg_05'),
      sdk.toolResult('toolu_odd', 'nothing'),
      sdk.toolResult('toolu_agent', 'Done.'),
    )
    await settle()

    expect(tracker.started).toEqual([
      [task.id, { toolUseId: 'toolu_1', cwd: '/code/acme-api', command: 'git commit -am Fix' }],
    ])
    expect(tracker.finished).toEqual([
      [
        task.id,
        { toolUseId: 'toolu_1', command: 'git commit -am Fix', output: '[main a1b2c3d] Fix', cwd: '/code/acme-api' },
      ],
      [
        task.id,
        {
          toolUseId: 'toolu_2',
          command: 'npm test && git commit -m Docs',
          output: 'FAIL test/date.test.ts',
          cwd: '/code/acme-api',
        },
      ],
    ])
  })

  it('a background subagent’s Bash call’s result, and that its session ended', async () => {
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_bg', 'abg', 'Update the docs'),
      sdk.toolUse('toolu_3', 'Bash', { command: 'git commit -m Docs' }, 'toolu_bg', 'msg_02'),
      sdk.toolResult('toolu_3', '[docs 0f1e2d3] Docs', false, 'toolu_bg'),
    )
    await settle()
    expect(tracker.finished.map(([, { toolUseId, output }]) => [toolUseId, output])).toEqual([
      ['toolu_3', '[docs 0f1e2d3] Docs'],
    ])

    backend.session.fail(new Error('The agent process exited'))
    await settle()
    expect(tracker.ended).toEqual([task.id])
  })
})

describe('the commits a task makes, end to end', () => {
  let repos: TestRepos
  let api: string
  let glade: GladeBridge
  let events: GladeEvent[]

  beforeEach(() => {
    repos = openTestRepos()
    api = repos.repo('acme-api')
    task = sampleTask(database.db, sampleWorkspace(database.db, api).id)
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
    events = []
    glade.subscribe((event) => events.push(event))
  })

  afterEach(() => {
    repos.close()
  })

  it('reach the window as they’re made, and the task’s history, the subagent’s labelled', async () => {
    // The app's own runner reads git through the PATH; this one reads none of the machine's config.
    runner.close()
    runner = createAgentRunner({
      db: database.db,
      emit: (event) => events.push(event),
      backend,
      changes: createChangeTracker({
        db: database.db,
        emit: (event) => events.push(event),
        git: createGit(TEST_GIT_RUN),
      }),
    })
    runner.send(task.id, 'Fix the test and commit it.')
    await settle()

    const command = 'git commit --allow-empty -m "Fix the UTC date test"'
    await backend.session.startBash({ toolUseId: 'toolu_1', cwd: api, command })
    const output = repos.sh(command, api)
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_agent', 'Agent', { description: 'Update the docs', prompt: 'Do it.' }),
      sdk.toolUse('toolu_1', 'Bash', { command }, 'toolu_agent', 'msg_02'),
      sdk.toolResult('toolu_1', output, false, 'toolu_agent'),
    )
    await settle()
    await vi.waitFor(() => {
      expect(listTaskCommits(database.db, task.id)).toHaveLength(1)
    })
    const commits = listTaskCommits(database.db, task.id)
    expect(commits[0]).toMatchObject({ subject: 'Fix the UTC date test', subagentToolUseId: 'toolu_agent' })
    expect(events).toContainEqual({ type: EventType.CommitsChanged, taskId: task.id, commits })
  })

  it('come with the task’s history, through the bridge', async () => {
    const tracker = createChangeTracker({ db: database.db, emit: () => undefined, git: createGit(TEST_GIT_RUN) })
    await tracker.bashStarting(task.id, { toolUseId: 'toolu_1', cwd: api, command: 'git commit' })
    const output = repos.sh('git commit --allow-empty -m "Fix the UTC date test"', api)
    await tracker.bashFinished(task.id, { toolUseId: 'toolu_1', command: 'git commit', output, cwd: api })

    const history = await glade.invoke(CommandName.TasksHistory, { id: task.id })
    expect(history.commits.map(({ subject }) => subject)).toEqual(['Fix the UTC date test'])
    const { repository } = await glade.invoke(CommandName.ChangesRepository, { taskId: task.id })
    expect(repository).toBe(true)
  })
})
