// #483: a failed e2e test keeps what's needed to diagnose it, the app's main log and the tasks as main has them, in
// its results; a test that passes keeps nothing. Checked on real failures: this spec starts a Playwright run of its
// own on tests that fail on purpose (`evidence/kept.inner.ts`), and reads what that run kept.
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { TaskActivity, TaskState } from '../src/shared/domain'
import { LOG_ATTACHMENT, TASKS_ATTACHMENT, TasksEvidenceKind } from './evidence'
import {
  DELIBERATE_FAILURE,
  INNER_OUTPUT_ENV,
  INNER_REPORT_ENV,
  INNER_TASK_TITLE,
  INNER_TESTS,
  INNER_WORKSPACE,
} from './evidence/inner'
import { expect, test } from './fixtures'

const ROOT = resolve(__dirname, '..')

/** The inner run's own config. */
const INNER_CONFIG = join('e2e', 'evidence', 'playwright.config.ts')

/** What the outer run tells its workers and its app that the inner run must decide for itself. */
const OUTER_ONLY_ENV = ['GLADE_RECORD_DIR', 'TEST_WORKER_INDEX', 'TEST_PARALLEL_INDEX']

/** How long the inner run gets: three launches of the app, on a machine that may be busy. */
const INNER_RUN_TIMEOUT_MS = 150_000

/** A test's attachment, as Playwright's JSON reporter lists it. */
const attachmentSchema = z.object({ name: z.string(), contentType: z.string(), path: z.string().optional() })

/** One run of a test, as the JSON reporter has it. */
const resultSchema = z.object({
  status: z.string(),
  errors: z.array(z.object({ message: z.string().optional() })),
  attachments: z.array(attachmentSchema),
})

/** The JSON reporter's report, as far as this spec reads it: the file's tests, each with its runs. */
const reportSchema = z.object({
  suites: z.array(
    z.object({
      specs: z.array(z.object({ title: z.string(), tests: z.array(z.object({ results: z.array(resultSchema) })) })),
    }),
  ),
})

type InnerResult = z.infer<typeof resultSchema>

/** `tasks.json` when main's tasks were read (`TasksRead` in `./evidence`), and nothing else: no paths, no content. */
const tasksReadSchema = z.strictObject({
  kind: z.literal(TasksEvidenceKind.Read),
  readAt: z.iso.datetime(),
  activeWorkspaceId: z.string().nullable(),
  selectedTaskId: z.string().nullable(),
  tasks: z.array(
    z.strictObject({
      id: z.string(),
      workspaceId: z.string(),
      workspaceName: z.string(),
      title: z.string(),
      state: z.enum(TaskState),
      activity: z.enum(TaskActivity),
      unread: z.boolean(),
      asking: z.boolean(),
      awaitingPermission: z.boolean(),
      backgroundWork: z.boolean(),
      updatedAt: z.number(),
    }),
  ),
})

/** `tasks.json` when they couldn't be (`TasksUnreadable`). */
const tasksUnreadableSchema = z.strictObject({
  kind: z.literal(TasksEvidenceKind.Unreadable),
  readAt: z.iso.datetime(),
  reason: z.string(),
})

/** What the inner run left: its exit code, and where its results and report are. */
interface InnerRun {
  readonly exitCode: number | null
  readonly results: string
  readonly report: string
}

/** Runs the inner tests in a Playwright run of their own, with its results and report in `folder`. */
function runInnerTests(folder: string): Promise<InnerRun> {
  const results = join(folder, 'results')
  const report = join(folder, 'report.json')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !OUTER_ONLY_ENV.includes(key)) env[key] = value
  }
  env[INNER_OUTPUT_ENV] = results
  env[INNER_REPORT_ENV] = report
  return new Promise((done, failed) => {
    const run = spawn('npx', ['playwright', 'test', '--config', INNER_CONFIG], {
      cwd: ROOT,
      env,
      stdio: 'ignore',
      timeout: INNER_RUN_TIMEOUT_MS,
    })
    run.on('error', failed)
    run.on('close', (exitCode) => {
      done({ exitCode, results, report })
    })
  })
}

/** The one run of the inner test called `title`. */
function resultOf(report: z.infer<typeof reportSchema>, title: string): InnerResult {
  const runs = report.suites
    .flatMap(({ specs }) => specs)
    .filter((spec) => spec.title === title)
    .flatMap(({ tests }) => tests)
    .flatMap(({ results }) => results)
  const [result] = runs
  if (result === undefined || runs.length !== 1)
    throw new Error(`Expected one run of "${title}", not ${String(runs.length)}`)
  return result
}

/** The names of what the `launch` fixture attached to a run, in order: Playwright adds its own page snapshot of a failure. */
function evidenceNames(result: InnerResult): string[] {
  return result.attachments.map(({ name }) => name).filter((name) => name !== 'error-context')
}

/** The text of a result's attachment called `name`, which must be a file inside the run's results. */
function attached(result: InnerResult, name: string, results: string): string {
  const path = result.attachments.find((attachment) => attachment.name === name)?.path
  if (path === undefined) throw new Error(`No ${name} attached`)
  expect(relative(results, path).startsWith('..'), `${name} is kept inside the results folder`).toBe(false)
  return readFileSync(path, 'utf8')
}

test('a failed test keeps the app’s log and the tasks as main has them in its results; a passing test keeps nothing', async ({
  tempFolder,
}) => {
  test.setTimeout(INNER_RUN_TIMEOUT_MS + 30_000)
  const { exitCode, results, report: reportFile } = await runInnerTests(tempFolder('glade-e2e-inner-'))
  // Playwright exits with 1 when tests failed: anything else means the run itself went wrong.
  expect(exitCode).toBe(1)
  const report = reportSchema.parse(JSON.parse(readFileSync(reportFile, 'utf8')))

  // A test that failed with its app still running: the tasks as main had them, and the log.
  const failed = resultOf(report, INNER_TESTS.fails)
  expect(failed.status).toBe('failed')
  expect(failed.errors.map(({ message }) => message).join('\n')).toContain(DELIBERATE_FAILURE)
  expect(evidenceNames(failed)).toEqual([TASKS_ATTACHMENT, LOG_ATTACHMENT])
  const tasks = tasksReadSchema.parse(JSON.parse(attached(failed, TASKS_ATTACHMENT, results)))
  expect(tasks.tasks).toHaveLength(1)
  const [task] = tasks.tasks
  expect(task).toMatchObject({
    workspaceName: INNER_WORKSPACE,
    title: INNER_TASK_TITLE,
    state: TaskState.Active,
    activity: TaskActivity.Waiting,
    // The reply landed in the task being viewed, so it's read.
    unread: false,
    asking: false,
    awaitingPermission: false,
    backgroundWork: false,
  })
  expect(tasks.selectedTaskId).toBe(task?.id)
  expect(tasks.activeWorkspaceId).toBe(task?.workspaceId)
  // The log is the app's own, whole: from the task's turn to the app quitting, after the tasks were read.
  const log = attached(failed, LOG_ATTACHMENT, results)
  expect(log).toContain(`"taskId":"${task?.id ?? ''}","msg":"turn ended"`)
  expect(log).toContain('"scope":"app","msg":"app quitting"')
  // Nothing kept names whose Mac it ran on: the runner's environment is left out, and the home folder isn't named.
  expect(log).not.toContain('"scope":"env"')
  expect(log).not.toContain(homedir())
  expect(JSON.stringify(tasks)).not.toContain(homedir())

  // A test that had closed its app by the time it failed: the log, and why there are no tasks.
  const failedClosed = resultOf(report, INNER_TESTS.failsClosed)
  expect(failedClosed.status).toBe('failed')
  expect(failedClosed.errors.map(({ message }) => message).join('\n')).toContain(DELIBERATE_FAILURE)
  expect(evidenceNames(failedClosed)).toEqual([TASKS_ATTACHMENT, LOG_ATTACHMENT])
  const unreadable = tasksUnreadableSchema.parse(JSON.parse(attached(failedClosed, TASKS_ATTACHMENT, results)))
  expect(unreadable.reason).toBe('The test left no app running to ask.')
  expect(attached(failedClosed, LOG_ATTACHMENT, results)).toContain('"msg":"turn ended"')

  // A test that passed: nothing attached, and no folder in the results.
  const passed = resultOf(report, INNER_TESTS.passes)
  expect(passed.status).toBe('passed')
  expect(passed.attachments).toEqual([])
  const folders = readdirSync(results, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  expect(folders).toHaveLength(2)
})
