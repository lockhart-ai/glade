/**
 * What a failed e2e test keeps (#483): the app's main log, and the tasks as main has them. The `launch` fixture
 * attaches both to a test that didn't pass, before it removes the test's throwaway data folder, the log with it. They
 * land in the test's folder under `out/e2e-results/`, which CI uploads when a shard fails. A test that passes keeps
 * nothing.
 *
 * Nothing kept names whose Mac the test ran on: the data folder and the workspaces are in the system temp folder, the
 * log's lines about the environment (the runner's own `PATH` and variables) are left out, and the home folder's path,
 * should anything else name it, is written `~` (`logToKeep`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { LogScope } from '../src/main/logging/logger'
import { needsYou } from '../src/shared/attention'
import { CommandName } from '../src/shared/bridge'
import { UiStateKey, type EpochMs, type Task, type TaskActivity, type TaskState } from '../src/shared/domain'
import { invoke } from './task-view'

/** The attachment holding the app's main log (`docs/logs.md`), every launch in the test. */
export const LOG_ATTACHMENT = 'main.log'

/** The attachment holding the tasks as main has them: a `TasksEvidence`, as JSON. */
export const TASKS_ATTACHMENT = 'tasks.json'

/** How long main gets to answer for its tasks: a window that's hung mustn't hold the test's teardown up. */
const READ_TIMEOUT_MS = 5000

/** A task as main has it: what says whether it needs you, and where it is. */
export interface TaskEvidence {
  readonly id: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly title: string
  readonly state: TaskState
  readonly activity: TaskActivity
  readonly unread: boolean
  readonly asking: boolean
  readonly awaitingPermission: boolean
  readonly backgroundWork: boolean
  readonly updatedAt: EpochMs
  /** Whether it needs you, by the rule everything that shows it uses (`needsYou` in `src/shared/attention.ts`). */
  readonly needsYou: boolean
}

/** Whether main's tasks could be read. */
export enum TasksEvidenceKind {
  Read = 'read',
  Unreadable = 'unreadable',
}

/** Main's tasks, in every workspace, and what main counts as viewed: a reply is judged against it (`attention.ts`). */
export interface TasksRead {
  readonly kind: TasksEvidenceKind.Read
  /** When they were read, in UTC, as the log's lines are timed. */
  readonly readAt: string
  /** The workspace the window shows, as main has it stored; null for none. */
  readonly activeWorkspaceId: string | null
  /** The task main has as the one you're viewing; null for none. */
  readonly selectedTaskId: string | null
  readonly tasks: readonly TaskEvidence[]
}

/** Main's tasks couldn't be read: the test had closed the app, or its window didn't answer. */
export interface TasksUnreadable {
  readonly kind: TasksEvidenceKind.Unreadable
  readonly readAt: string
  readonly reason: string
}

export type TasksEvidence = TasksRead | TasksUnreadable

/** A task's evidence: the fields that decide its attention, none of its content. */
function taskEvidence(task: Task, workspaceName: string): TaskEvidence {
  const { id, workspaceId, title, state, activity, unread, asking, awaitingPermission, backgroundWork, updatedAt } =
    task
  return {
    id,
    workspaceId,
    workspaceName,
    title,
    state,
    activity,
    unread,
    asking,
    awaitingPermission,
    backgroundWork,
    updatedAt,
    needsYou: needsYou(task),
  }
}

/** Reads every workspace's tasks, and the stored selection, from main through the window's bridge. */
async function tasksInMain(window: Page): Promise<Omit<TasksRead, 'kind' | 'readAt'>> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { entries } = await invoke(window, CommandName.UiStateGetAll, {})
  const stored = (key: UiStateKey): string | null => {
    const value = entries.find((entry) => entry.key === key)?.value ?? ''
    return value === '' ? null : value
  }
  const tasks: TaskEvidence[] = []
  for (const workspace of workspaces) {
    const listed = await invoke(window, CommandName.TasksList, { workspaceId: workspace.id })
    tasks.push(...listed.tasks.map((task) => taskEvidence(task, workspace.name)))
  }
  return {
    activeWorkspaceId: stored(UiStateKey.ActiveWorkspaceId),
    selectedTaskId: stored(UiStateKey.SelectedTaskId),
    tasks,
  }
}

/**
 * The tasks as main has them, read through `window`: the last app the test launched that's still running, or
 * undefined when it closed them all. Never rejects: what went wrong reading them is the evidence then.
 */
export async function readTasksEvidence(window: Page | undefined): Promise<TasksEvidence> {
  const readAt = new Date().toISOString()
  if (window === undefined) {
    return { kind: TasksEvidenceKind.Unreadable, readAt, reason: 'The test left no app running to ask.' }
  }
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Main didn't answer within ${String(READ_TIMEOUT_MS)} ms.`))
    }, READ_TIMEOUT_MS)
  })
  try {
    const read = await Promise.race([tasksInMain(window), timedOut])
    return { kind: TasksEvidenceKind.Read, readAt, ...read }
  } catch (error) {
    return { kind: TasksEvidenceKind.Unreadable, readAt, reason: withoutHome(String(error)) }
  } finally {
    clearTimeout(timer)
  }
}

/** `text` with the home folder's path written `~`, so nothing kept from a run names whose Mac it ran on. */
export function withoutHome(text: string, home: string = homedir()): string {
  return home === '' || home === '/' ? text : text.replaceAll(home, '~')
}

/** How a line of the log names its scope (`formatRecord`): the `env` scope's lines are the ones left out. */
const ENV_SCOPE_LINE = `"scope":"${LogScope.Env}"`

/**
 * The app's log as it's kept: without the `env` scope's lines, and with the home folder's path written `~`. Those
 * lines say the environment the agents run in, which in a test mode is the test runner's own: its `PATH` and, at
 * debug, every variable, the user's name and folders among them. They say nothing about what the app did.
 */
export function logToKeep(log: string, home: string = homedir()): string {
  const kept = log.split('\n').filter((line) => !line.includes(ENV_SCOPE_LINE))
  return withoutHome(kept.join('\n'), home)
}

/** A test's evidence, as the `launch` fixture gathered it. */
export interface Evidence {
  /** The app's log file, in the test's data folder: it may not exist, if the app never started. */
  readonly logFile: string
  /** The tasks as main had them, read while the app still ran (`readTasksEvidence`). */
  readonly tasks: TasksEvidence
  /** A throwaway folder to write the attachments in on their way to the results: the test's data folder does. */
  readonly stagingFolder: string
}

/**
 * Attaches a test's evidence to its results: the tasks as main had them, and the app's log. Call it once the test's
 * apps have quit, so the log is whole, while its data folder still exists, and only for a test that didn't pass.
 *
 * Each is attached as a file, which Playwright copies into the test's results (`<test>/attachments/`) and its
 * reporters name: an attachment given as a body would only be in a report, and the list reporter keeps none.
 */
export async function attachEvidence(testInfo: TestInfo, { logFile, tasks, stagingFolder }: Evidence): Promise<void> {
  const folder = join(stagingFolder, 'evidence')
  mkdirSync(folder, { recursive: true })
  const attach = async (name: string, content: string, contentType: string): Promise<void> => {
    const path = join(folder, name)
    writeFileSync(path, content)
    await testInfo.attach(name, { path, contentType })
  }
  await attach(TASKS_ATTACHMENT, `${JSON.stringify(tasks, null, 2)}\n`, 'application/json')
  if (existsSync(logFile)) await attach(LOG_ATTACHMENT, logToKeep(readFileSync(logFile, 'utf8')), 'text/plain')
}
