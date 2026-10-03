// Porting a long Claude Code session in has to stay quick: a 20,000-line transcript imports in under 5 seconds and
// lists in under 1, and a few hundred sessions page quickly once read.
//
// The budgets are in CPU time (see search.perf.test.ts), counted in references timed just before, on the same machine
// under the same load: the least any reader of the transcript has to do (read the file and JSON.parse each line), and
// for the import the least any importer writing through the app's repositories has to do (that, then write each line
// into a table in one transaction, with a statement prepared for it). An idle Mac, a busy one and one held to its
// efficiency cores differ several times over in milliseconds, but little in references, so a budget can be tight
// enough that twice the work fails without a slow or busy machine failing. (On the Mac they were set on, the import's
// budget of 15 references is about 3.3s, inside its 5s.)
//
// The store reference prepares a statement for each line because the import does: each repository call prepares its
// own (about 27,000 of them for this transcript, 14 distinct), and preparing is about 40% of the import. Preparing
// (SQLite's parser and code generator) slows down far more on a busy machine or its efficiency cores than running one
// statement over and over does, so a reference that prepared once swung against the import: the import took 11
// references on an idle Mac and up to 22 held to its efficiency cores under load, when twice the work is 22 (#375).
// Against a reference that prepares for each line it takes 8 idle and at most 13.4 held to its efficiency cores under
// load, and twice the work 17. Opening the reference's database, which runs every migration, isn't timed either: it's
// no part of writing a line.
//
// Each is timed a few times and the fastest counts: on a busy machine noise only ever adds time (a collection the last
// step left behind, another process's cache misses, a disk others are writing to), so the fastest run is the one
// closest to the work itself. Reading is also held to linear time, reading the transcript once against reading one a
// tenth as long ten times, so a parser that slows down as the transcript grows fails however fast the machine is. (The
// import as a whole isn't: its database writes would hide a parser's quadratic cost at this size.)
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TaskState } from '../../../shared/domain'
import { listMessages } from '../../db/repositories/messages'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from '../../db/repositories/test-database'
import { listToolEvents } from '../../db/repositories/tool-events'
import { createClaudeCodeSessions, type ClaudeCodeSessions } from './service'
import { SESSION_ID, TranscriptBuilder, writeTranscript } from './test-transcripts'
import { readTranscript, type TranscriptFile } from './transcripts'

const LINES = 20_000
/** The baseline for linear time: a transcript a tenth as long, read ten times over. */
const BASELINE_LINES = LINES / 10
const BASELINE_READS = LINES / BASELINE_LINES

/**
 * The budgets, in references, as `npm test` measures them (with coverage): each is about 1.75 times what it takes on an
 * idle Mac, so twice the work fails, and about 1.4 times the most it took on a busy one held to its efficiency cores.
 */
const BUDGET = {
  /** Reading the transcript: about 4, and at most 5.3. */
  read: 7,
  /** Listing it, which reads it too: about 4, and at most 4.9. */
  list: 7,
  /**
   * Importing it: about 8, and at most 13.4. Twice the work takes about 17, so this one sits between the two rather
   * than at 1.75 times idle.
   */
  import: 15,
  /**
   * Listing the second page of 300 sessions once the first has read them: about 0.15. It shows the page comes from
   * what the first read, which took about 2: reading them all again fails.
   */
  page: 1,
} as const

/** How much longer reading the transcript once may take than reading a tenth of it ten times: it takes about as long. */
const MAX_SCALING = 1.5

/** How many times each thing is timed, the fastest counting. */
const RUNS = 5
/** How many times the import is timed: it takes much longer. */
const IMPORT_RUNS = 3
/** How many times a reference is timed before each timing, the fastest counting. */
const REFERENCE_RUNS = 3

/**
 * A guard against a hang, not a budget: the budgets are CPU time, and a machine this test runs on at a tenth of its
 * speed would still pass them. (Held to its efficiency cores with the other test files alongside, the import's test
 * once took over 5 minutes on the clock.)
 */
const TIMEOUT_MS = 600_000

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

/** TEMPORARY (#442 measurement): prints what a test measured, for the CI logs. Removed before this merges. */
function report(test: string, measured: Record<string, unknown>): void {
  const sabotage = process.env['GLADE_PERF_SABOTAGE'] ?? 'none'
  console.log(
    `PERF442 ${JSON.stringify({ test, platform: process.platform, arch: process.arch, sabotage, ...measured })}`,
  )
}

/** The CPU time this process has used, in milliseconds. */
function cpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/** How much CPU time `run` takes, in milliseconds. */
async function cpuTime(run: () => Promise<void> | void): Promise<number> {
  const start = cpuMs()
  await run()
  return cpuMs() - start
}

/** The fastest of `runs` timings of `run`, in milliseconds of CPU time. */
async function fastest(runs: number, run: () => Promise<void> | void): Promise<number> {
  let best = Infinity
  for (let time = 0; time < runs; time += 1) best = Math.min(best, await cpuTime(run))
  return best
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

/** A long session, written into a fresh fixture's projects folder. */
interface LongSession {
  readonly fixture: Fixture
  readonly file: TranscriptFile
  /** Its turns: nine lines each, seven of conversation and two of noise. */
  readonly turns: number
}

function writeLongSession(lines: number): LongSession {
  const created = fixture()
  const builder = longSession(created.cwd, lines)
  expect(builder.lines.length).toBeGreaterThanOrEqual(lines)
  const text = builder.toJsonl()
  const path = writeTranscript(created.projects, created.cwd, text)
  return {
    fixture: created,
    file: { path, sessionId: SESSION_ID, size: text.length, modifiedAt: 0 },
    turns: builder.lines.length / 9,
  }
}

/** A session's lines, as Claude Code wrote them. */
function linesOf({ file }: LongSession): string[] {
  return readFileSync(file.path, 'utf8').split('\n').slice(0, -1)
}

/** The read reference: reading a session's file and JSON.parse on each of its lines, in milliseconds of CPU time. */
function readReferenceMs(session: LongSession): Promise<number> {
  return fastest(REFERENCE_RUNS, () => {
    for (const line of linesOf(session)) JSON.parse(line)
  })
}

/**
 * The store reference: writing each of a session's lines into a table of a fresh database, in one transaction, with a
 * statement prepared for each line as the app's repositories prepare one for each row, in milliseconds of CPU time.
 * Only the writing counts, not opening the database (which migrates it) or closing it.
 */
async function storeReferenceMs(session: LongSession): Promise<number> {
  const lines = linesOf(session)
  let best = Infinity
  for (let time = 0; time < REFERENCE_RUNS; time += 1) {
    const database = openTestDatabase()
    try {
      const { db } = database
      db.exec('CREATE TABLE lines (id INTEGER PRIMARY KEY, line TEXT NOT NULL)')
      const store = db.transaction(() => {
        for (const line of lines) db.prepare('INSERT INTO lines (line) VALUES (?)').run(line)
      })
      best = Math.min(best, await cpuTime(store))
    } finally {
      database.close()
    }
  }
  return best
}

/** Reads a session's transcript, checking it all came through. */
async function read({ file, turns }: LongSession): Promise<void> {
  expect((await readTranscript(file)).turns).toHaveLength(turns)
}

/** Lists a session's projects folder afresh, as a new window would, with nothing read yet. */
async function listAfresh({ fixture: { database, projects } }: LongSession): Promise<void> {
  const sessions = createClaudeCodeSessions({ db: database.db, emit: () => undefined, projectsDir: projects })
  expect((await sessions.list({ limit: 50 })).sessions).toHaveLength(1)
}

it(
  `reads a ${String(LINES)}-line transcript in linear time within ${String(BUDGET.read)} references, and lists it within ${String(BUDGET.list)}`,
  async () => {
    const full = writeLongSession(LINES)
    const baseline = writeLongSession(BASELINE_LINES)

    let readRefs = Infinity
    let listRefs = Infinity
    let fullMs = Infinity
    let baselineMs = Infinity
    const samples: number[][] = []
    for (let run = 0; run < RUNS; run += 1) {
      const reference = await readReferenceMs(full)
      const readMs = await cpuTime(() => read(full))
      const listMs = await cpuTime(() => listAfresh(full))
      samples.push([reference, readMs / reference, listMs / reference])
      readRefs = Math.min(readRefs, readMs / reference)
      listRefs = Math.min(listRefs, listMs / reference)
      fullMs = Math.min(fullMs, readMs)
      baselineMs = Math.min(
        baselineMs,
        await cpuTime(async () => {
          for (let time = 0; time < BASELINE_READS; time += 1) await read(baseline)
        }),
      )
    }

    report('read', { readRefs, listRefs, scaling: fullMs / baselineMs, fullMs, baselineMs, samples })
    expect(readRefs).toBeLessThan(BUDGET.read)
    expect(listRefs).toBeLessThan(BUDGET.list)
    // Ten times the lines, once, take about as long as a tenth of them ten times.
    expect(fullMs).toBeLessThan(baselineMs * MAX_SCALING)
  },
  TIMEOUT_MS,
)

it(
  `imports a ${String(LINES)}-line transcript within ${String(BUDGET.import)} references`,
  async () => {
    // A warm-up, a tenth the size.
    const { sessions } = writeLongSession(BASELINE_LINES).fixture
    await sessions.import({ session: { sessionId: SESSION_ID }, state: TaskState.Done, createWorkspace: false })

    let importRefs = Infinity
    const samples: number[][] = []
    for (let run = 0; run < IMPORT_RUNS; run += 1) {
      // Each import needs a database that doesn't have the session yet.
      const session = writeLongSession(LINES)
      const { database, sessions } = session.fixture
      const reference = (await readReferenceMs(session)) + (await storeReferenceMs(session))
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
      expect(listMessages(database.db, taskId)).toHaveLength(session.turns * 2)
      expect(listToolEvents(database.db, taskId)).toHaveLength(session.turns * 4)
      importRefs = Math.min(importRefs, importMs / reference)
      samples.push([reference, importMs / reference])
    }
    report('import', { importRefs, samples })

    expect(importRefs).toBeLessThan(BUDGET.import)
  },
  TIMEOUT_MS,
)

it(
  `lists a few hundred sessions, and pages through them within ${String(BUDGET.page)} reference once read`,
  async () => {
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
    const long = writeLongSession(LINES)

    const first = await sessions.list({ limit: 200 })
    expect(first.sessions).toHaveLength(200)
    expect(first.sessions[0]?.sessionId).toBe('session-299')
    const cursor = first.nextCursor === null ? {} : { cursor: first.nextCursor }

    let pageRefs = Infinity
    const samples: number[][] = []
    for (let run = 0; run < RUNS; run += 1) {
      const reference = await readReferenceMs(long)
      const pageMs = await cpuTime(async () => {
        const second = await sessions.list({ limit: 200, ...cursor })
        expect(second.sessions).toHaveLength(100)
        expect(second.nextCursor).toBeNull()
      })
      pageRefs = Math.min(pageRefs, pageMs / reference)
      samples.push([reference, pageMs / reference])
    }
    report('page', { pageRefs, samples })
    expect(pageRefs).toBeLessThan(BUDGET.page)
  },
  TIMEOUT_MS,
)
