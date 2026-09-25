// Porting a long Claude Code session in has to stay quick: a 20,000-line transcript imports in under 5 seconds and
// lists in under 1, and a few hundred sessions page quickly once read.
//
// The budgets are in CPU time, not on the wall clock (see search.perf.test.ts): on a shared CI runner the test files
// running alongside take the CPU away, which the wall clock counts and CPU time doesn't. Reading the transcript is also
// held to a baseline measured in the same run, a transcript a tenth as long, so a parser that slows down as the
// transcript grows fails however fast the machine is. (The import as a whole isn't: its database writes grow a little
// faster than linear on a busy machine, and they would hide a parser's quadratic cost at this size anyway.)
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TaskState } from '../../../shared/domain'
import { listMessages } from '../../db/repositories/messages'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from '../../db/repositories/test-database'
import { listToolEvents } from '../../db/repositories/tool-events'
import { createClaudeCodeSessions, type ClaudeCodeSessions } from './service'
import { SESSION_ID, TranscriptBuilder, writeTranscript } from './test-transcripts'
import { readTranscript } from './transcripts'

const LINES = 20_000
const IMPORT_BUDGET_MS = 5_000
const LIST_BUDGET_MS = 1_000
/** The baseline: a transcript a tenth as long, which a linear parser reads in a tenth of the time. */
const BASELINE_LINES = LINES / 10
/** How many baselines reading the full transcript may take: half again linear, so noise passes and quadratic fails. */
const MAX_SCALING = 15
const RUNS = 3

/** A fresh database and projects folder, with one workspace, to list and import sessions from. */
interface Fixture {
  readonly database: TestDatabase
  readonly root: string
  readonly projects: string
  readonly cwd: string
  readonly sessions: ClaudeCodeSessions
}

const fixtures: Fixture[] = []

function fixture(): Fixture {
  const database = openTestDatabase()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-import-perf-')))
  const projects = join(root, 'projects')
  const cwd = join(root, 'acme-api')
  mkdirSync(cwd)
  sampleWorkspace(database.db, cwd)
  const sessions = createClaudeCodeSessions({ db: database.db, emit: () => undefined, projectsDir: projects })
  const created = { database, root, projects, cwd, sessions }
  fixtures.push(created)
  return created
}

afterEach(() => {
  for (const { database, root } of fixtures.splice(0)) {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/** The CPU time this process has used, in milliseconds. */
function cpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/** How much CPU time `run` takes, in milliseconds. */
async function cpuTime(run: () => Promise<void>): Promise<number> {
  const start = cpuMs()
  await run()
  return cpuMs() - start
}

function median(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Infinity
}

/**
 * A long session: turn after turn of a prompt, some narration, two tool calls with sizeable results and a reply, seven
 * lines of conversation each, with an attachment and a queue operation between turns as Claude Code writes them.
 */
function longSession(cwd: string, lines: number): TranscriptBuilder {
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

/** What reading, listing and then importing a session took, in milliseconds of CPU time. */
interface Timing {
  readonly readMs: number
  readonly listMs: number
  readonly importMs: number
}

/** Reads, lists and imports a fresh session of `lines` lines, checking it all came in, and answers how long each took. */
async function measure(lines: number): Promise<Timing> {
  const { database, projects, cwd, sessions } = fixture()
  const builder = longSession(cwd, lines)
  const text = builder.toJsonl()
  const path = writeTranscript(projects, cwd, text)
  expect(builder.lines.length).toBeGreaterThanOrEqual(lines)

  // The transcript parser on its own: the import's writes to the database would hide it growing faster than linear.
  const readMs = await cpuTime(async () => {
    const file = { path, sessionId: SESSION_ID, size: text.length, modifiedAt: 0 }
    expect((await readTranscript(file)).turns).toHaveLength(builder.lines.length / 9)
  })
  const listMs = await cpuTime(async () => {
    expect((await sessions.list({ limit: 50 })).sessions).toHaveLength(1)
  })
  let taskId = ''
  const importMs = await cpuTime(async () => {
    const { task, imported } = await sessions.import({
      session: { sessionId: SESSION_ID },
      state: TaskState.Done,
      createWorkspace: false,
    })
    expect(imported).toBe(true)
    taskId = task.id
  })

  // Nine lines a turn: seven of conversation and two of noise.
  const turns = builder.lines.length / 9
  expect(listMessages(database.db, taskId)).toHaveLength(turns * 2)
  expect(listToolEvents(database.db, taskId)).toHaveLength(turns * 4)
  return { readMs, listMs, importMs }
}

/** The median of each timing over a few runs, after a warm-up. */
async function medianTiming(lines: number): Promise<Timing> {
  await measure(lines)
  const runs: Timing[] = []
  for (let run = 0; run < RUNS; run += 1) runs.push(await measure(lines))
  return {
    readMs: median(runs.map((timing) => timing.readMs)),
    listMs: median(runs.map((timing) => timing.listMs)),
    importMs: median(runs.map((timing) => timing.importMs)),
  }
}

it(`imports a ${String(LINES)}-line transcript in under ${String(IMPORT_BUDGET_MS / 1000)}s, and lists it in under ${String(LIST_BUDGET_MS / 1000)}s, of CPU time`, async () => {
  const baseline = await medianTiming(BASELINE_LINES)
  const full = await medianTiming(LINES)

  expect(full.listMs).toBeLessThan(LIST_BUDGET_MS)
  expect(full.importMs).toBeLessThan(IMPORT_BUDGET_MS)
  // Ten times the lines take about ten times as long to read.
  expect(full.readMs).toBeLessThan(baseline.readMs * MAX_SCALING)
}, 60_000)

it('lists a few hundred sessions, and pages through them quickly once read', async () => {
  const { projects, cwd, sessions } = fixture()
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

  let second = first
  const pageMs = await cpuTime(async () => {
    second = await sessions.list({ limit: 200, ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }) })
  })
  expect(second.sessions).toHaveLength(100)
  expect(second.nextCursor).toBeNull()
  expect(pageMs).toBeLessThan(LIST_BUDGET_MS)
}, 30_000)
