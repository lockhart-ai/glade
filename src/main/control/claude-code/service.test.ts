import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../../shared/bridge'
import {
  CompactionTrigger,
  DividerKind,
  Effort,
  MessageRole,
  PermissionMode,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type Workspace,
} from '../../../shared/domain'
import { MODEL_OPTIONS } from '../../../shared/models'
import { listMessages } from '../../db/repositories/messages'
import { updateSettings } from '../../db/repositories/settings'
import { getTask, updateTask } from '../../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../../db/repositories/test-database'
import { listToolEvents } from '../../db/repositories/tool-events'
import { listWorkspaces } from '../../db/repositories/workspaces'
import { ControlError, ControlErrorCode } from '../errors'
import {
  createClaudeCodeSessions,
  decodeCursor,
  encodeCursor,
  IMPORTED_STATUS,
  NO_RESULT_NOTE,
  offeredModel,
  type ClaudeCodeSessions,
  type ImportClaudeCodeSessionInput,
} from './service'
import { ms, plainChat, projectSlug, SESSION_ID, TranscriptBuilder, writeTranscript } from './test-transcripts'

const NOW = ms(10_000)

let database: TestDatabase
let root: string
let projects: string
/** The session's folder, which exists on disk. */
let cwd: string
let workspace: Workspace
let events: GladeEvent[]
let sessions: ClaudeCodeSessions

beforeEach(() => {
  database = openTestDatabase()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-import-')))
  projects = join(root, 'claude', 'projects')
  cwd = join(root, 'acme-api')
  mkdirSync(projects, { recursive: true })
  mkdirSync(cwd)
  workspace = sampleWorkspace(database.db, cwd)
  events = []
  sessions = createClaudeCodeSessions({
    db: database.db,
    emit: (event) => events.push(event),
    projectsDir: projects,
    now: () => NOW,
  })
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

/** A transcript that has everything an import writes: tools, narration, a failure, a call with no result, compaction. */
function fullSession(folder: string = cwd): TranscriptBuilder {
  return new TranscriptBuilder(folder)
    .noise(0)
    .prompt(0, 'Fix the rate limit tests, then tidy the README.')
    .say(1, "I'll run them first.")
    .toolUse(2, 'toolu_1', 'Bash', { command: 'npm test' })
    .toolResult(4, 'toolu_1', '2 failed', true)
    .toolUse(5, 'toolu_2', 'Edit', {
      file_path: join(folder, 'test/rate.test.ts'),
      old_string: 'a',
      new_string: 'b\nc',
    })
    .toolResult(6, 'toolu_2', 'Edited.')
    .say(7, 'Fixed: the tests used the wall clock.')
    .aiTitle('Fix rate limit tests')
    .prompt(60, 'Now the README.')
    .compaction(61, 'auto', 160_000)
    .toolUse(62, 'toolu_3', 'Read', { file_path: join(folder, 'README.md') })
}

function importInput(overrides: Partial<ImportClaudeCodeSessionInput> = {}): ImportClaudeCodeSessionInput {
  return { session: { sessionId: SESSION_ID }, state: TaskState.Done, createWorkspace: false, ...overrides }
}

async function importFails(
  input: ImportClaudeCodeSessionInput,
  code: ControlErrorCode,
  message: RegExp,
): Promise<void> {
  const failure = await sessions.import(input).then(
    () => null,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(ControlError)
  expect(failure).toMatchObject({ code, message: expect.stringMatching(message) as unknown })
}

function taskCount(): number {
  return database.db.prepare('SELECT COUNT(*) FROM tasks').pluck().get() as number
}

describe('import', () => {
  it('imports a session as a done task, with its chat and tool log at their original times', async () => {
    writeTranscript(projects, cwd, fullSession().toJsonl())

    const result = await sessions.import(importInput())

    expect(result.imported).toBe(true)
    expect(result.skipped).toEqual({ lines: 2, images: 0 })
    const { task } = result
    expect(task).toMatchObject({
      workspaceId: workspace.id,
      title: 'Fix rate limit tests',
      objective: 'Fix the rate limit tests, then tidy the README.',
      status: IMPORTED_STATUS,
      state: TaskState.Done,
      activity: TaskActivity.Waiting,
      model: 'claude-haiku-4-5',
      sessionId: SESSION_ID,
      createdAt: ms(0),
      updatedAt: ms(62),
      doneAt: ms(62),
      importedAt: NOW,
      unread: false,
      pinned: false,
    })
    expect(getTask(database.db, task.id)).toEqual(task)

    expect(
      listMessages(database.db, task.id).map(({ role, body, turn, createdAt, summary }) => ({
        role,
        body,
        turn,
        createdAt,
        summary,
      })),
    ).toEqual([
      {
        role: MessageRole.User,
        body: 'Fix the rate limit tests, then tidy the README.',
        turn: 1,
        createdAt: ms(0),
        summary: null,
      },
      {
        role: MessageRole.Agent,
        body: 'Fixed: the tests used the wall clock.',
        turn: 1,
        createdAt: ms(7),
        summary: { durationMs: 7_000, filesChanged: 1, linesAdded: 2, linesRemoved: 1 },
      },
      { role: MessageRole.User, body: 'Now the README.', turn: 2, createdAt: ms(60), summary: null },
    ])

    const log = listToolEvents(database.db, task.id)
    expect(log.map((event) => [event.kind, event.turn, event.createdAt])).toEqual([
      [ToolEventKind.Divider, 1, ms(0)],
      [ToolEventKind.Narration, 1, ms(1)],
      [ToolEventKind.ToolCall, 1, ms(2)],
      [ToolEventKind.ToolCall, 1, ms(5)],
      [ToolEventKind.Divider, 2, ms(60)],
      [ToolEventKind.Compaction, 2, ms(61)],
      [ToolEventKind.ToolCall, 2, ms(62)],
    ])
    expect(log[0]).toMatchObject({ dividerKind: DividerKind.Turn })
    expect(log[1]).toMatchObject({ text: "I'll run them first.", parentToolUseId: null })
    expect(log[2]).toMatchObject({
      name: 'Bash',
      input: { command: 'npm test' },
      toolUseId: 'toolu_1',
      state: ToolCallState.Error,
      output: '2 failed',
      finishedAt: ms(4),
      parentToolUseId: null,
    })
    expect(log[3]).toMatchObject({ name: 'Edit', state: ToolCallState.Done, output: 'Edited.', finishedAt: ms(6) })
    expect(log[5]).toMatchObject({
      trigger: CompactionTrigger.Auto,
      state: ToolCallState.Done,
      preTokens: 160_000,
      postTokens: null,
      windowTokens: 200_000,
    })
    expect(log[6]).toMatchObject({ state: ToolCallState.Interrupted, output: NO_RESULT_NOTE, finishedAt: ms(62) })

    // Once it has committed, the windows hear of the task.
    expect(events).toEqual([{ type: EventType.TaskUpdated, task }])
  })

  it("keeps the session's todo progress on the task, for its row", async () => {
    const session = new TranscriptBuilder(cwd)
      .prompt(0, 'Move the uploads to S3.')
      .toolUse(1, 'toolu_1', 'TaskCreate', { subject: 'Find the uploads', description: 'Find the uploads' })
      .toolResult(2, 'toolu_1', 'Task #1 created successfully: Find the uploads')
      .toolUse(3, 'toolu_2', 'TaskCreate', { subject: 'Copy the files', description: 'Copy the files' })
      .toolResult(4, 'toolu_2', 'Task #2 created successfully: Copy the files')
      .toolUse(5, 'toolu_3', 'TaskUpdate', { taskId: '1', status: 'completed' })
      .toolResult(6, 'toolu_3', 'Updated task #1 status')
    writeTranscript(projects, cwd, session.toJsonl())

    const { task } = await sessions.import(importInput())

    expect(task.todos).toEqual({ done: 1, total: 2, doing: [] })
    expect(getTask(database.db, task.id)?.todos).toEqual(task.todos)
    expect(events).toEqual([{ type: EventType.TaskUpdated, task }])
  })

  it('imports by path too, and active when asked', async () => {
    const path = writeTranscript(projects, cwd, plainChat(cwd).toJsonl())
    const { task } = await sessions.import(importInput({ session: { path }, state: TaskState.Active }))
    expect(task).toMatchObject({ state: TaskState.Active, doneAt: null, updatedAt: ms(70), sessionId: SESSION_ID })
    // With no title of its own, the first line of the first prompt.
    expect(task.title).toBe('Why do the rate limit tests fail on CI?')
  })

  it("titles it by the first prompt's first line, cut short, and cuts the objective", async () => {
    const long = `\n\n${'Rewrite the rate limiter so that it '.repeat(5)}\nand then more.\n${'x'.repeat(600)}`
    writeTranscript(projects, cwd, new TranscriptBuilder(cwd).prompt(0, long).say(1, 'OK.').toJsonl())
    const { task } = await sessions.import(importInput())
    expect(task.title.length).toBeLessThanOrEqual(80)
    expect(task.title.startsWith('Rewrite the rate limiter so that it')).toBe(true)
    expect(task.title.endsWith('…')).toBe(true)
    expect(task.objective.length).toBe(500)
    expect(task.objective.startsWith('Rewrite the rate limiter')).toBe(true)
  })

  it("uses Settings' defaults for what the transcript doesn't say, or Glade doesn't offer", async () => {
    updateSettings(database.db, {
      defaultModel: 'claude-sonnet-5',
      defaultEffort: Effort.Low,
      defaultPermissionMode: PermissionMode.AskBeforeEdits,
    })
    writeTranscript(
      projects,
      cwd,
      plainChat(cwd)
        .say(80, 'Older model.', {
          message: { model: 'claude-3-opus-20240229', content: [{ type: 'text', text: 'x' }] },
        })
        .toJsonl(),
    )
    const { task } = await sessions.import(importInput())
    expect(task).toMatchObject({
      model: 'claude-sonnet-5',
      effort: Effort.Low,
      permissionMode: PermissionMode.AskBeforeEdits,
    })
  })

  it('is idempotent: importing again returns the same task and changes nothing', async () => {
    const path = writeTranscript(projects, cwd, fullSession().toJsonl())
    const first = await sessions.import(importInput())
    events = []

    const again = await sessions.import(importInput())
    const byPath = await sessions.import(importInput({ session: { path }, state: TaskState.Active }))

    expect(again).toEqual({ task: first.task, imported: false, skipped: { lines: 0, images: 0 } })
    expect(byPath.task).toEqual(first.task)
    expect(taskCount()).toBe(1)
    expect(events).toEqual([])
  })

  it('makes one task of two imports of the same session at once', async () => {
    writeTranscript(projects, cwd, fullSession().toJsonl())
    const path = join(projects, projectSlug(cwd), `${SESSION_ID}.jsonl`)

    const results = await Promise.all([
      sessions.import(importInput()),
      sessions.import(importInput({ session: { path } })),
      sessions.import(importInput()),
    ])

    expect(taskCount()).toBe(1)
    expect(results.filter((result) => result.imported)).toHaveLength(1)
    expect(new Set(results.map((result) => result.task.id)).size).toBe(1)
    expect(listToolEvents(database.db, results[0].task.id)).toHaveLength(7)
    expect(events.filter((event) => event.type === EventType.TaskUpdated)).toHaveLength(1)
  })

  it('returns the task that has the session when another import took it first', async () => {
    writeTranscript(projects, cwd, plainChat(cwd).toJsonl())
    // Another process imported it between this import's check and its write: the unique index refuses the second.
    const other = sampleTask(database.db, workspace.id)
    let checks = 0
    const db = database.db
    const prepare = db.prepare.bind(db)
    db.prepare = (source: string) => {
      if (source === 'SELECT id FROM tasks WHERE session_id = ?') {
        checks += 1
        // The check before reading and the one in the transaction miss it (it lands just after the first); the one
        // after the refusal finds it.
        if (checks === 1) updateTask(db, other.id, { sessionId: SESSION_ID })
        if (checks <= 2) return prepare("SELECT id FROM tasks WHERE session_id = ? AND id = 'none'")
      }
      return prepare(source)
    }

    const result = await sessions.import(importInput())

    expect(result).toMatchObject({ imported: false, task: { id: other.id } })
    expect(taskCount()).toBe(1)
    expect(events).toEqual([])
  })

  it('leaves nothing behind when a write fails mid-import', async () => {
    writeTranscript(projects, cwd, fullSession().toJsonl())
    database.db.exec(`
      CREATE TEMP TRIGGER fail_compaction BEFORE INSERT ON tool_events WHEN new.kind = 'compaction'
      BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `)

    await expect(sessions.import(importInput())).rejects.toThrow('disk full')

    expect(taskCount()).toBe(0)
    expect(database.db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0)
    expect(database.db.prepare('SELECT COUNT(*) FROM tool_events').pluck().get()).toBe(0)
    expect(events).toEqual([])

    // And it imports once the problem is gone.
    database.db.exec('DROP TRIGGER fail_compaction')
    await expect(sessions.import(importInput())).resolves.toMatchObject({ imported: true })
  })

  it('fails for a folder no workspace has, and with createWorkspace adds one as Add workspace does', async () => {
    const other = join(root, 'acme-dashboard')
    mkdirSync(other)
    writeTranscript(projects, other, plainChat(other).toJsonl())

    await importFails(importInput(), ControlErrorCode.ImportFailed, /No workspace has the session's folder/)
    expect(taskCount()).toBe(0)
    expect(existsSync(join(other, 'CLAUDE.md'))).toBe(false)

    const { task } = await sessions.import(importInput({ createWorkspace: true }))
    const added = listWorkspaces(database.db).find((each) => each.rootPath === other)
    expect(added).toMatchObject({ name: 'acme-dashboard', createdAt: NOW })
    expect(task.workspaceId).toBe(added?.id)
    expect(existsSync(join(other, 'CLAUDE.md'))).toBe(true)
    expect(events).toEqual([
      { type: EventType.WorkspaceUpdated, workspace: added },
      { type: EventType.TaskUpdated, task },
    ])
  })

  it('goes only into the workspace whose root is exactly its folder', async () => {
    const sub = join(cwd, 'packages', 'client')
    mkdirSync(sub, { recursive: true })
    writeTranscript(projects, sub, plainChat(sub).toJsonl())
    await importFails(importInput(), ControlErrorCode.ImportFailed, /No workspace/)
    // A trailing slash is the same folder.
    rmSync(join(projects, projectSlug(sub)), { recursive: true })
    writeTranscript(projects, cwd, plainChat(`${cwd}/`).toJsonl())
    await expect(sessions.import(importInput())).resolves.toMatchObject({ task: { workspaceId: workspace.id } })
  })

  it('fails for a folder that no longer exists, even with createWorkspace', async () => {
    const gone = join(root, 'deleted-project')
    writeTranscript(projects, gone, plainChat(gone).toJsonl())
    sampleWorkspace(database.db, gone)
    for (const createWorkspace of [false, true]) {
      await importFails(importInput({ createWorkspace }), ControlErrorCode.ImportFailed, /no longer exists/)
    }
    expect(taskCount()).toBe(0)
  })

  it('fails for a session with no messages, or that says no folder', async () => {
    writeTranscript(projects, cwd, new TranscriptBuilder(cwd).noise(0).toJsonl())
    await importFails(importInput(), ControlErrorCode.ImportFailed, /has no messages/)
    writeTranscript(projects, cwd, '{"type":"user","message":{"content":"Hi"}}\n')
    await importFails(importInput(), ControlErrorCode.ImportFailed, /doesn't say its folder/)
  })

  it('fails for no such session, and for a path outside the projects folder, with .., or through a symlink', async () => {
    await importFails(importInput(), ControlErrorCode.NotFound, /No session/)
    await importFails(
      importInput({ session: { path: join(projects, 'acme', 'missing.jsonl') } }),
      ControlErrorCode.ImportFailed,
      /No such file/,
    )
    const outside = join(root, 'outside.jsonl')
    writeFileSync(outside, plainChat(cwd).toJsonl())
    mkdirSync(join(projects, 'linked'))
    symlinkSync(outside, join(projects, 'linked', 'session.jsonl'))
    for (const path of [
      outside,
      `${projects}/linked/../../outside.jsonl`,
      join(projects, 'linked', 'session.jsonl'),
      'relative/session.jsonl',
    ]) {
      await importFails(
        importInput({ session: { path } }),
        ControlErrorCode.ImportFailed,
        /not a Claude Code transcript/,
      )
    }
    expect(taskCount()).toBe(0)
  })

  it("imports a Glade task's own session as that task", async () => {
    const own = updateTask(database.db, sampleTask(database.db, workspace.id).id, { sessionId: SESSION_ID })
    writeTranscript(projects, cwd, plainChat(cwd).toJsonl())

    const result = await sessions.import(importInput())

    expect(result).toEqual({ task: own, imported: false, skipped: { lines: 0, images: 0 } })
    expect(listMessages(database.db, own.id)).toEqual([])
  })
})

describe('list', () => {
  function writeSession(sessionId: string, builder: TranscriptBuilder): string {
    return writeTranscript(projects, builder.cwd, builder.toJsonl(), sessionId)
  }

  it('lists each session with its folder, title, first prompt, times, messages, workspace and task', async () => {
    const path = writeSession(SESSION_ID, fullSession())
    const other = join(root, 'acme-dashboard')
    writeSession('dash-1', plainChat(other).customTitle('Dashboard charts'))

    const page = await sessions.list({ limit: 50 })

    expect(page).toEqual({
      sessions: [
        {
          sessionId: 'dash-1',
          path: join(projects, projectSlug(other), 'dash-1.jsonl'),
          cwd: other,
          title: 'Dashboard charts',
          firstPrompt: 'Why do the rate limit tests fail on CI?',
          startedAt: ms(0),
          lastActivityAt: ms(70),
          messages: 4,
          workspaceId: null,
          taskId: null,
        },
        {
          sessionId: SESSION_ID,
          path,
          cwd,
          title: 'Fix rate limit tests',
          firstPrompt: 'Fix the rate limit tests, then tidy the README.',
          startedAt: ms(0),
          lastActivityAt: ms(62),
          messages: 3,
          workspaceId: workspace.id,
          taskId: null,
        },
      ],
      nextCursor: null,
    })
  })

  it("shows the task that has each session: an imported one, or a Glade task's own", async () => {
    writeSession(SESSION_ID, plainChat(cwd))
    writeSession('own-1', plainChat(cwd))
    const own = updateTask(database.db, sampleTask(database.db, workspace.id).id, { sessionId: 'own-1' })
    const { task } = await sessions.import(importInput())

    const { sessions: listed } = await sessions.list({ limit: 50 })
    expect(Object.fromEntries(listed.map((session) => [session.sessionId, session.taskId]))).toEqual({
      [SESSION_ID]: task.id,
      'own-1': own.id,
    })
    expect((await sessions.list({ limit: 50, imported: false })).sessions).toEqual([])
    expect((await sessions.list({ limit: 50, imported: true })).sessions).toHaveLength(2)
  })

  it('filters by folder and by a query over the title and first prompt', async () => {
    writeSession('a', plainChat(cwd).aiTitle('Timezone bug'))
    writeSession(
      'b',
      new TranscriptBuilder(join(root, 'acme-dashboard')).prompt(0, 'Draw the latency chart').say(1, 'Done.'),
    )
    writeSession('c', new TranscriptBuilder(cwd).prompt(0, 'Bump the TIMEZONE library').say(1, 'Bumped.'))

    const ids = async (input: Parameters<ClaudeCodeSessions['list']>[0]): Promise<string[]> =>
      (await sessions.list(input)).sessions.map((session) => session.sessionId).sort()
    expect(await ids({ limit: 50, cwd })).toEqual(['a', 'c'])
    expect(await ids({ limit: 50, cwd: `${cwd}/` })).toEqual(['a', 'c'])
    expect(await ids({ limit: 50, query: '  timezone ' })).toEqual(['a', 'c'])
    expect(await ids({ limit: 50, query: 'LATENCY' })).toEqual(['b'])
    expect(await ids({ limit: 50, query: 'nothing like it' })).toEqual([])
    expect(await ids({ limit: 50, query: '' })).toEqual(['a', 'b', 'c'])
  })

  it('pages newest first, ties by session id, with a cursor', async () => {
    for (const [id, last] of [
      ['s1', 10],
      ['s2', 30],
      ['s3', 20],
      ['s4', 30],
      ['s5', 5],
    ] as const) {
      writeSession(id, new TranscriptBuilder(cwd).prompt(0, `Task ${id}`).say(last, 'Done.'))
    }
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await sessions.list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) })
      seen.push(...page.sessions.map((session) => session.sessionId))
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor !== undefined)
    expect(seen).toEqual(['s2', 's4', 's3', 's1', 's5'])
    expect(pages).toBe(3)
    // A cursor Glade didn't make starts from the top.
    expect((await sessions.list({ limit: 1, cursor: 'not a cursor' })).sessions[0]?.sessionId).toBe('s2')
  })

  it("leaves out sessions that can't be imported: no messages, or no folder", async () => {
    writeSession('empty', new TranscriptBuilder(cwd))
    writeSession('noise', new TranscriptBuilder(cwd).noise(0))
    writeTranscript(projects, cwd, '{"type":"user","message":{"content":"Hi"}}\n', 'no-folder')
    writeSession(SESSION_ID, plainChat(cwd))
    expect((await sessions.list({ limit: 50 })).sessions.map((session) => session.sessionId)).toEqual([SESSION_ID])
  })

  it('cuts a long first prompt', async () => {
    writeSession(SESSION_ID, new TranscriptBuilder(cwd).prompt(0, 'word '.repeat(100)).say(1, 'OK.'))
    const [session] = (await sessions.list({ limit: 50 })).sessions
    expect(session?.firstPrompt.length).toBeLessThanOrEqual(200)
    expect(session?.firstPrompt.endsWith('…')).toBe(true)
  })

  it('reads a transcript again only when it changed', async () => {
    const path = writeSession(SESSION_ID, plainChat(cwd))
    utimesSync(path, new Date(ms(100)), new Date(ms(100)))
    expect((await sessions.list({ limit: 50 })).sessions[0]?.messages).toBe(4)

    // Same size and time: the summary stands, whatever the file now says.
    const same = plainChat(cwd).toJsonl().replace('Why do', 'How do')
    writeFileSync(path, same)
    utimesSync(path, new Date(ms(100)), new Date(ms(100)))
    expect((await sessions.list({ limit: 50 })).sessions[0]?.firstPrompt).toMatch(/^Why do/)

    // Changed: it's read again.
    writeFileSync(path, plainChat(cwd).prompt(80, 'One more.').toJsonl())
    utimesSync(path, new Date(ms(200)), new Date(ms(200)))
    expect((await sessions.list({ limit: 50 })).sessions[0]?.messages).toBe(5)
  })

  it('lists nothing when Claude Code has no projects folder', async () => {
    rmSync(projects, { recursive: true })
    expect(await sessions.list({ limit: 50 })).toEqual({ sessions: [], nextCursor: null })
  })

  it('leaves out a transcript it cannot read', async () => {
    writeSession(SESSION_ID, plainChat(cwd))
    const unreadable = writeSession('locked', plainChat(cwd))
    // A folder where a file should be: listed by name, then fails to read.
    rmSync(unreadable)
    mkdirSync(unreadable)
    writeFileSync(join(projects, projectSlug(cwd), 'x.jsonl'), '')
    expect((await sessions.list({ limit: 50 })).sessions.map((session) => session.sessionId)).toEqual([SESSION_ID])
  })
})

describe('cursors', () => {
  it('round-trips, and reads anything else as none', () => {
    expect(decodeCursor(encodeCursor({ lastActivityAt: 5, sessionId: 's' }))).toEqual({
      lastActivityAt: 5,
      sessionId: 's',
    })
    for (const text of [
      '',
      '%%%',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('[1]').toString('base64url'),
      Buffer.from('["1","s"]').toString('base64url'),
    ]) {
      expect(decodeCursor(text), text).toBeNull()
    }
  })
})

describe('offeredModel', () => {
  it('finds the model Glade offers by its id, dated or not', () => {
    expect(offeredModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(offeredModel('claude-haiku-4-5')).toBe('claude-haiku-4-5')
    expect(offeredModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(offeredModel('claude-opus-5-5')).toBe(MODEL_OPTIONS[0].id)
    expect(offeredModel('claude-opus-5-5[1m]')).toBe(MODEL_OPTIONS[0].id)
    expect(offeredModel('claude-opus-5-5-20260101[1m]')).toBe(MODEL_OPTIONS[0].id)
    // Not a different version that happens to start the same.
    expect(offeredModel('claude-sonnet-5-5')).toBeNull()
    expect(offeredModel('claude-3-opus-20240229')).toBeNull()
  })
})
