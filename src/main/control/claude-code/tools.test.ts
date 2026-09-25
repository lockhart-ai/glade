// `list_claude_code_sessions` and `import_claude_code_session` through a real MCP client, against the app's bridge on
// a temporary database and a temporary Claude Code projects folder of invented transcripts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType } from '../../../shared/bridge'
import { TaskState, type Workspace } from '../../../shared/domain'
import { sampleTask, sampleWorkspace } from '../../db/repositories/test-database'
import { ControlErrorCode } from '../errors'
import { ControlToolName } from '../names'
import {
  asTask,
  connect,
  errorCode,
  errorMessage,
  HTTP,
  startControlApp,
  type ControlApp,
  type ControlClient,
} from '../test-control'
import { IMPORTED_STATUS } from './service'
import { ms, plainChat, SESSION_ID, writeTranscript } from './test-transcripts'

let root: string
let projects: string
let cwd: string
let app: ControlApp
let workspace: Workspace
let client: ControlClient

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-cc-tools-')))
  projects = join(root, 'projects')
  cwd = join(root, 'acme-api')
  mkdirSync(cwd)
  app = startControlApp(true, projects)
  workspace = sampleWorkspace(app.database.db, cwd)
  client = await connect(app.bridge.control.server(HTTP))
})

afterEach(async () => {
  await client.close()
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('list_claude_code_sessions', () => {
  it('lists the sessions, with whether each is in Glade', async () => {
    const path = writeTranscript(projects, cwd, plainChat(cwd).toJsonl())

    const reply = await client.call(ControlToolName.ListClaudeCodeSessions)

    expect(reply.isError).toBe(false)
    expect(reply.json).toEqual({
      sessions: [
        {
          sessionId: SESSION_ID,
          path,
          cwd,
          title: null,
          firstPrompt: 'Why do the rate limit tests fail on CI?',
          startedAt: ms(0),
          lastActivityAt: ms(70),
          messages: 4,
          workspaceId: workspace.id,
          taskId: null,
        },
      ],
      nextCursor: null,
    })
    expect(JSON.parse(reply.text)).toEqual(reply.json)
  })

  it('refuses input that fails its schema, naming the field', async () => {
    for (const [input, field] of [
      [{ limit: 201 }, 'limit'],
      [{ limit: 0 }, 'limit'],
      [{ imported: 'yes' }, 'imported'],
      [{ query: '  ' }, 'query'],
      [{ everything: true }, 'everything'],
    ] as const) {
      const reply = await client.call(ControlToolName.ListClaudeCodeSessions, input)
      expect(errorCode(reply), JSON.stringify(input)).toBe(ControlErrorCode.InvalidInput)
      expect(errorMessage(reply)).toContain(field)
    }
  })
})

describe('import_claude_code_session', () => {
  it('imports a session as a done task, and says it did; importing again returns the same task', async () => {
    writeTranscript(projects, cwd, plainChat(cwd).noise(80).toJsonl())
    const events = app.events.length

    const reply = await client.call(ControlToolName.ImportClaudeCodeSession, { sessionId: SESSION_ID })

    expect(reply.isError).toBe(false)
    expect(reply.json).toMatchObject({
      imported: true,
      skipped: { lines: 2, images: 0 },
      task: {
        title: 'Why do the rate limit tests fail on CI?',
        status: IMPORTED_STATUS,
        state: TaskState.Done,
        sessionId: SESSION_ID,
        turns: 2,
        workspace: { id: workspace.id, rootPath: cwd, doneTasks: 1 },
        importedAt: expect.any(Number) as unknown,
      },
    })
    expect(app.events.slice(events).map((event) => event.type)).toEqual([EventType.TaskUpdated])

    const again = await client.call(ControlToolName.ImportClaudeCodeSession, { sessionId: SESSION_ID, state: 'active' })
    expect(again.json).toMatchObject({ imported: false, task: { state: TaskState.Done }, skipped: { lines: 0 } })

    // The listing now shows its task.
    const listed = await client.call(ControlToolName.ListClaudeCodeSessions, { imported: true })
    expect(listed.json).toMatchObject({
      sessions: [{ sessionId: SESSION_ID, taskId: (reply.json.task as { id: string }).id }],
    })
  })

  it('imports by path, active, and into a new workspace when asked', async () => {
    const other = join(root, 'acme-dashboard')
    mkdirSync(other)
    const path = writeTranscript(projects, other, plainChat(other).toJsonl())

    const refused = await client.call(ControlToolName.ImportClaudeCodeSession, { path })
    expect(errorCode(refused)).toBe(ControlErrorCode.ImportFailed)
    expect(errorMessage(refused)).toContain('No workspace')

    const reply = await client.call(ControlToolName.ImportClaudeCodeSession, {
      path,
      state: 'active',
      createWorkspace: true,
    })
    expect(reply.json).toMatchObject({
      imported: true,
      task: { state: TaskState.Active, workspace: { name: 'acme-dashboard', rootPath: other } },
    })
  })

  it('says not_found for no such session, and import_failed for a path outside the projects folder', async () => {
    const missing = await client.call(ControlToolName.ImportClaudeCodeSession, { sessionId: 'no-such-session' })
    expect(errorCode(missing)).toBe(ControlErrorCode.NotFound)
    const outside = await client.call(ControlToolName.ImportClaudeCodeSession, { path: join(root, 'x.jsonl') })
    expect(errorCode(outside)).toBe(ControlErrorCode.ImportFailed)
  })

  it('needs exactly one of sessionId and path, and knows only done and active', async () => {
    for (const input of [
      {},
      { sessionId: SESSION_ID, path: join(projects, 'a', 'b.jsonl') },
      { sessionId: SESSION_ID, state: 'archived' },
      { sessionId: SESSION_ID, createWorkspace: 'yes' },
    ]) {
      const reply = await client.call(ControlToolName.ImportClaudeCodeSession, input)
      expect(errorCode(reply), JSON.stringify(input)).toBe(ControlErrorCode.InvalidInput)
    }
  })

  it('is refused while agents may not control Glade, like every tool', async () => {
    writeTranscript(projects, cwd, plainChat(cwd).toJsonl())
    const off = startControlApp(false, projects)
    const offClient = await connect(off.bridge.control.server(HTTP))
    try {
      for (const name of [ControlToolName.ListClaudeCodeSessions, ControlToolName.ImportClaudeCodeSession]) {
        const reply = await offClient.call(name, { sessionId: SESSION_ID })
        expect(errorCode(reply), name).toBe(ControlErrorCode.Disabled)
      }
    } finally {
      await offClient.close()
      await off.close()
    }
  })

  it('lets a task import its own session, which returns that task', async () => {
    const task = sampleTask(app.database.db, workspace.id)
    app.database.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(SESSION_ID, task.id)
    writeTranscript(projects, cwd, plainChat(cwd).toJsonl())
    const own = await connect(app.bridge.control.server(asTask(task.id)))
    try {
      const reply = await own.call(ControlToolName.ImportClaudeCodeSession, { sessionId: SESSION_ID })
      expect(reply.json).toMatchObject({ imported: false, task: { id: task.id } })
    } finally {
      await own.close()
    }
  })
})
