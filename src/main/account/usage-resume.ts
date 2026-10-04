/**
 * Ending a usage limit's pauses before the limit's own reset (#519, `docs/design/html/17-usage-limit.html`).
 *
 * - **Resume now**, on the banner, tries every turn a usage limit paused again at once, in every workspace, each on its
 *   own model (`resumeUsageLimitPauses`).
 * - **By itself**, when the account can run again: you turned extra usage on, say, or moved to a bigger plan. While any
 *   task is paused on a usage limit, Glade reads the account's usage again when its window gets the focus, and every
 *   `USAGE_RECHECK_MS` on one timer for the whole app, which exists only for that long. Each answer of the usage call
 *   (those, and the ones every session's turns already ask for) is put to each such pause (`canRunAgain`, in
 *   `../agent/pauses`), and the ones it says can run are resumed, as one batch.
 *
 * Either way a turn still over the limit pauses again, with the reset time it's given. So a reading that's wrong costs
 * one refused request a task, and no more: a task is resumed on what a reading says only when that differs from what
 * the reading before said of it (`RunAgain.evidence`), so nothing is retried over and over. What each task was last
 * told is kept in memory alone: a relaunch may try each paused task once more.
 *
 * The usage call needs a live session to ask (`AgentRunner.refreshUsage`). A task's session outlives its turn, paused
 * or not, so there's one as long as a task has run since Glade started; after a relaunch with nothing run yet there's
 * none, nothing is read, and the pauses wait for Resume now or their own timers. Offline pauses are never touched.
 */
import type { Database } from 'better-sqlite3'
import type { UsageSnapshot } from '../../shared/account'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { PauseReason, TaskActivity, TaskState, type EpochMs, type Task, type TaskPause } from '../../shared/domain'
import { canRunAgain, USAGE_RECHECK_MIN_GAP_MS, USAGE_RECHECK_MS } from '../agent/pauses'
import type { AgentRunner } from '../agent/runner'
import type { Batch } from '../bridge/dispatcher'
import { getTask, listPausedTasks } from '../db/repositories/tasks'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

/** A task whose turn a usage limit paused. */
interface LimitedTask extends Task {
  readonly pause: TaskPause
}

/** Whether a usage limit paused the task's turn. */
function isLimited(task: Task): task is LimitedTask {
  return (
    task.state === TaskState.Active &&
    task.activity === TaskActivity.Paused &&
    task.pause?.reason === PauseReason.UsageLimit
  )
}

/** Every workspace's tasks a usage limit paused, oldest first. */
function limitedTasks(db: Database): LimitedTask[] {
  return listPausedTasks(db).filter(isLimited)
}

export interface UsageResumeContext {
  readonly db: Database
  /** What resumes a paused turn. */
  readonly runner: Pick<AgentRunner, 'resumePaused'>
  /** Where the resumed tasks are logged. Nothing by default. */
  readonly log?: Logger
}

/**
 * Resumes every task a usage limit paused, in every workspace, oldest first, each on its own model; or, given `only`,
 * those of them. Answers with the tasks resumed, as they now are: working, or, for one whose pause was all that held
 * permission requests the app quit on, waiting on you (`AgentRunner.resumePaused`).
 */
export function resumeUsageLimitPauses(
  { db, runner, log = SILENT_LOGGER }: UsageResumeContext,
  only?: ReadonlySet<string>,
): Task[] {
  const resumed = limitedTasks(db)
    .filter((task) => only?.has(task.id) ?? true)
    .flatMap((task) => {
      runner.resumePaused(task.id)
      return getTask(db, task.id) ?? []
    })
  log.info('tasks paused on a usage limit resumed', { tasks: resumed.length })
  return resumed
}

/** What resumes the tasks a usage limit paused when the account can run again (see the module comment). */
export interface UsageResume {
  /** Hears every event main sends the windows: a task pausing on a usage limit, or leaving its pause, times the reads. */
  observe(event: GladeEvent): void
  /** Glade's window got the focus: reads usage again, while a task is paused on a usage limit. */
  focused(): void
  /** The usage call answered: resumes the paused tasks it says can run again, once (see the module comment). */
  usageRead(usage: UsageSnapshot): void
  /** Stops the reads' timer, e.g. when the app quits. */
  close(): void
}

export interface UsageResumeOptions {
  readonly db: Database
  readonly runner: Pick<AgentRunner, 'resumePaused' | 'refreshUsage'>
  /** Sends the windows what the resumed tasks emit as one batch. Each event goes as it's emitted by default. */
  readonly batch?: Batch
  readonly log?: Logger
  readonly now?: () => EpochMs
}

export function createUsageResume({
  db,
  runner,
  batch = (run) => run(),
  log = SILENT_LOGGER,
  now = () => Date.now(),
}: UsageResumeOptions): UsageResume {
  // The tasks a usage limit has paused, as launch found them and the events have said since.
  const limited = new Set(limitedTasks(db).map((task) => task.id))
  // What the last reading said of each task it was put to (`RunAgain.evidence`), or null when it said it can't run.
  const told = new Map<string, string | null>()
  let timer: ReturnType<typeof setInterval> | null = null
  let lastAsked: EpochMs | null = null

  /** Asks for a reading, unless nothing is paused on a usage limit or one was only just asked for. */
  const read = (why: string): void => {
    if (limited.size === 0) return
    const at = now()
    if (lastAsked !== null && at - lastAsked < USAGE_RECHECK_MIN_GAP_MS) return
    const asked = runner.refreshUsage()
    if (asked) lastAsked = at
    log.info(asked ? 'usage asked for again' : 'usage not asked for again: no session is live', {
      why,
      paused: limited.size,
    })
  }

  /** Keeps the timer for exactly as long as a task is paused on a usage limit. */
  const time = (): void => {
    if (limited.size > 0 && timer === null) {
      log.info('usage is read again every few minutes: a task is paused on a usage limit')
      timer = setInterval(() => {
        read('timer')
      }, USAGE_RECHECK_MS)
      // Never what keeps the process going: the app quits whether or not it was closed.
      timer.unref()
    } else if (limited.size === 0 && timer !== null) {
      log.info('usage is no longer read again: nothing is paused on a usage limit')
      clearInterval(timer)
      timer = null
    }
  }

  time()

  return {
    observe(event) {
      if (event.type === EventType.TaskUpdated) {
        if (isLimited(event.task)) limited.add(event.task.id)
        else limited.delete(event.task.id)
      } else if (event.type === EventType.TaskDeleted) {
        limited.delete(event.taskId)
        told.delete(event.taskId)
      } else return
      time()
    },
    focused() {
      read('focus')
    },
    usageRead(usage) {
      if (limited.size === 0) return
      const due = new Set<string>()
      for (const task of limitedTasks(db)) {
        const verdict = canRunAgain(task.pause, usage)
        const evidence = verdict?.evidence ?? null
        const before = told.get(task.id)
        told.set(task.id, evidence)
        if (verdict === null || evidence === before) continue
        log.with({ taskId: task.id }).info('usage says the paused task can run again', { reason: verdict.reason })
        due.add(task.id)
      }
      if (due.size > 0) batch(() => resumeUsageLimitPauses({ db, runner, log }, due))
    },
    close() {
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}
