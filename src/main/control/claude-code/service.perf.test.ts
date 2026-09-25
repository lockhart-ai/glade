// Porting a long Claude Code session in has to stay quick: a 20,000-line transcript imports in under 5 seconds and
// lists in under 1, and a few hundred sessions page quickly once read.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TaskState } from '../../../shared/domain'
import { listMessages } from '../../db/repositories/messages'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from '../../db/repositories/test-database'
import { listToolEvents } from '../../db/repositories/tool-events'
import { createClaudeCodeSessions, type ClaudeCodeSessions } from './service'
import { SESSION_ID, TranscriptBuilder, writeTranscript } from './test-transcripts'

const LINES = 20_000
const IMPORT_BUDGET_MS = 5_000
const LIST_BUDGET_MS = 1_000

let database: TestDatabase
let root: string
let projects: string
let cwd: string
let sessions: ClaudeCodeSessions

beforeEach(() => {
  database = openTestDatabase()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-import-perf-')))
  projects = join(root, 'projects')
  cwd = join(root, 'acme-api')
  mkdirSync(cwd)
  sampleWorkspace(database.db, cwd)
  sessions = createClaudeCodeSessions({ db: database.db, emit: () => undefined, projectsDir: projects })
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

/**
 * A long session: turn after turn of a prompt, some narration, two tool calls with sizeable results and a reply, seven
 * lines of conversation each, with an attachment and a queue operation between turns as Claude Code writes them.
 */
function longSession(lines: number): TranscriptBuilder {
  const builder = new TranscriptBuilder(cwd)
  const output = 'PASS test/rate.test.ts\n'.repeat(40)
  for (let turn = 0; builder.lines.length < lines; turn += 1) {
    const t = turn * 10
    builder
      .prompt(t, `Step ${String(turn)}: run the rate limit tests and fix what fails.`)
      .say(t + 1, 'Running the tests.')
      .toolUse(t + 2, `toolu_${String(turn)}_a`, 'Bash', { command: 'npm test -- rate' })
      .toolResult(t + 3, `toolu_${String(turn)}_a`, output)
      .toolUse(t + 4, `toolu_${String(turn)}_b`, 'Edit', {
        file_path: join(cwd, 'src/rate.ts'),
        old_string: 'Date.now()',
        new_string: 'clock.now()',
      })
      .toolResult(t + 5, `toolu_${String(turn)}_b`, 'Edited.')
      .say(t + 6, `Step ${String(turn)} done.`)
      .noise(t + 7)
  }
  return builder
}

it(`imports a ${String(LINES)}-line transcript in under ${String(IMPORT_BUDGET_MS / 1000)}s, and lists it in under ${String(LIST_BUDGET_MS / 1000)}s`, async () => {
  const builder = longSession(LINES)
  writeTranscript(projects, cwd, builder.toJsonl())
  expect(builder.lines.length).toBeGreaterThanOrEqual(LINES)

  const listStarted = performance.now()
  const page = await sessions.list({ limit: 50 })
  const listMs = performance.now() - listStarted
  expect(page.sessions).toHaveLength(1)

  const importStarted = performance.now()
  const { task, imported } = await sessions.import({
    session: { sessionId: SESSION_ID },
    state: TaskState.Done,
    createWorkspace: false,
  })
  const importMs = performance.now() - importStarted

  expect(imported).toBe(true)
  // Nine lines a turn: seven of conversation and two of noise.
  const turns = builder.lines.length / 9
  expect(listMessages(database.db, task.id)).toHaveLength(turns * 2)
  expect(listToolEvents(database.db, task.id)).toHaveLength(turns * 4)
  expect(listMs).toBeLessThan(LIST_BUDGET_MS)
  expect(importMs).toBeLessThan(IMPORT_BUDGET_MS)
}, 30_000)

it('lists a few hundred sessions, and pages through them quickly once read', async () => {
  for (let index = 0; index < 300; index += 1) {
    const builder = new TranscriptBuilder(cwd)
    for (let turn = 0; turn < 10; turn += 1) {
      builder
        .prompt(index * 100 + turn, `Session ${String(index)}, step ${String(turn)}`)
        .say(index * 100 + turn, 'Done.')
    }
    writeTranscript(projects, cwd, builder.toJsonl(), `session-${String(index).padStart(3, '0')}`)
  }

  const first = await sessions.list({ limit: 200 })
  expect(first.sessions).toHaveLength(200)
  expect(first.sessions[0]?.sessionId).toBe('session-299')

  const started = performance.now()
  const second = await sessions.list({ limit: 200, ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }) })
  const pageMs = performance.now() - started
  expect(second.sessions).toHaveLength(100)
  expect(second.nextCursor).toBeNull()
  expect(pageMs).toBeLessThan(LIST_BUDGET_MS)
}, 30_000)
