/**
 * The watchers: what a task's agent left running or scheduled with the SDK's own tools, for the Watchers tab
 * (`docs/sdk-notes.md` §13). Glade builds no watching of its own: the agent writes whatever script it likes and runs
 * it with `Monitor` or `Bash`'s `run_in_background`, or schedules itself with `ScheduleWakeup` or `CronCreate`, and
 * Glade follows each one from what the SDK reports:
 *
 * - **Monitor** and **Command** (a background `Bash`): the SDK starts a task for each (`task_started`, `local_bash`),
 *   which the watcher is made from, with the call's description and command. Each time one wakes the agent, its
 *   wake's prompt names it (`./notices`): a monitor's event lines, or its ending. The SDK's `task_notification` says
 *   how it ended: finished, failed or stopped (by you, the agent, or its timeout).
 * - **Wakeup** (`ScheduleWakeup`) and **Cron** (`CronCreate`): made from the call's result (the wakeup's time, the
 *   job's id and schedule). A job firing wakes the agent with its prompt, which is how its wakes are counted: a
 *   wakeup, or a one-off job, is finished once it fires. At the end of each turn the SDK lists the jobs it still has:
 *   that names a wakeup's job id, brings back a job suspended by a relaunch, and ends one the SDK no longer has (a
 *   recurring job expires after 7 days). `CronDelete` is the agent stopping one; `ScheduleWakeup` with `stop` its
 *   wakeups.
 *
 * **Stop.** A monitor or command is stopped by the runner, with the SDK's `stopTask`; it's marked as yours first, so
 * its ending says so. A wakeup or job has no such means from outside the session (only the agent's `CronDelete`): it's
 * marked stopped at once, and its fires are turned away before they start a turn (`prompt` answers `Block`), for as
 * long as the session keeps it. A message of yours is never turned away: the runner checks its own prompts first.
 *
 * **Relaunches.** A session's processes and wakeups die with it; its cron jobs come back when it resumes. So on launch,
 * and when a session fails, running watchers and scheduled wakeups end as stopped, and scheduled cron jobs are
 * suspended until the session next lists them.
 *
 * Every change is saved, then broadcast as the task's watchers (`watchers.changed`).
 */
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { EventType } from '../../shared/bridge'
import { LIVE_WATCHER_STATES, WatcherKind, WatcherState, type EpochMs, type ToolCallEvent } from '../../shared/domain'
import type { Emit } from '../bridge/events'
import { getToolCall } from '../db/repositories/tool-events'
import {
  addWatcher,
  findWatcherBySdkId,
  getWatcher,
  listLiveWatchers,
  listWatchers,
  publicWatcher,
  updateWatcher,
  type StoredWatcher,
  type WatcherChange,
} from '../db/repositories/watchers'
import { PromptVerdict, type SessionJob } from '../agent/backend'
import { TaskOutcome, type SubagentStartedEvent, type TaskFinishedEvent, type ToolResultEvent } from '../agent/events'
import { nextCronTime } from './cron'
import { lastLine, parseTaskNotices, type TaskNotice } from './notices'

/** What a watcher you stopped says. */
export const STOPPED_BY_YOU = 'You stopped it.'
/** What a monitor or command the agent stopped (`TaskStop`) says. */
export const STOPPED_BY_AGENT = 'The agent stopped it.'
/** What a monitor that ran out its timeout says. */
export const TIMED_OUT = 'It timed out.'
/** What a job the agent deleted (`CronDelete`, or `ScheduleWakeup` with `stop`) says. */
export const CANCELLED_BY_AGENT = 'The agent cancelled it.'
/** What a wakeup or one-off job that fired says. */
export const FIRED = 'It fired.'
/** What a job the session no longer has, without it firing or being deleted (a recurring job expires), says. */
export const NO_LONGER_SCHEDULED = 'The agent’s session no longer has it.'
/** What a watcher the app quit on says: its process or wakeup died with the session. */
export const STOPPED_BY_RELAUNCH = 'Stopped by the relaunch.'

/** The tools that start a task Glade follows as a watcher, by the name of the call that started it. */
const MONITOR_TOOL = 'Monitor'
const SCHEDULE_WAKEUP_TOOL = 'ScheduleWakeup'
const CRON_CREATE_TOOL = 'CronCreate'
const CRON_DELETE_TOOL = 'CronDelete'

/** Claude Code's default and longest `Monitor` timeouts (`timeout_ms`). */
const MONITOR_DEFAULT_TIMEOUT_MS = 300_000
const MONITOR_MAX_TIMEOUT_MS = 1_800_000
/** How early a monitor's stop can come and still be its timeout: Glade's clock starts it a moment after the SDK's. */
const TIMEOUT_SLACK_MS = 2_000

/** The kinds that are tasks the SDK runs, and the kinds that are jobs it schedules. */
const TASK_KINDS: readonly WatcherKind[] = [WatcherKind.Monitor, WatcherKind.Command]
const JOB_KINDS: readonly WatcherKind[] = [WatcherKind.Wakeup, WatcherKind.Cron]

// The calls' inputs and the SDK's accounts of their results (`tool_use_result`), as far as the watchers read them.
// A field of the wrong shape is as good as missing.
const optionalText = z.string().optional().catch(undefined)
const monitorInput = z.looseObject({
  description: optionalText,
  command: optionalText,
  timeout_ms: z.number().positive().optional().catch(undefined),
  ws: z.looseObject({ url: z.string() }).optional().catch(undefined),
})
const monitorResult = z.looseObject({
  timeoutMs: z.number().nonnegative().optional().catch(undefined),
  persistent: z.boolean().optional().catch(undefined),
})
const bashInput = z.looseObject({ description: optionalText, command: optionalText })
const wakeupInput = z.looseObject({
  reason: optionalText,
  prompt: optionalText,
  stop: z.boolean().optional().catch(undefined),
})
const wakeupResult = z.looseObject({ scheduledFor: z.number().positive() })
const cronInput = z.looseObject({ cron: z.string(), prompt: z.string() })
const cronResult = z.looseObject({
  id: z.string().min(1),
  humanSchedule: optionalText,
  recurring: z.boolean().optional().catch(undefined),
})
const cronDeleteInput = z.looseObject({ id: z.string() })

export interface WatcherTrackerOptions {
  readonly db: Database
  readonly emit: Emit
  /** The clock. `Date.now` by default. */
  readonly now?: () => EpochMs
}

/** What the runner does to stop a watcher you asked to stop (`requestStop`). */
export enum StopAction {
  /** Stop the SDK's task with this id (`stopTask`): its ending arrives as a task notification. */
  StopTask = 'stop_task',
  /** Nothing more: it's stopped already. */
  None = 'none',
}

export type StopRequest =
  { readonly action: StopAction.StopTask; readonly sdkTaskId: string } | { readonly action: StopAction.None }

export interface WatcherTracker {
  /** The SDK started a task for a tool call: a monitor or background command becomes a watcher. */
  taskStarted(taskId: string, event: SubagentStartedEvent): void
  /** A tool call got its result: a wakeup or cron job is made, or one is deleted, by the agent. */
  toolResult(taskId: string, call: ToolCallEvent, event: ToolResultEvent): void
  /** The SDK says a task ended: its watcher ends the same way. */
  taskFinished(taskId: string, event: TaskFinishedEvent): void
  /**
   * A prompt not of Glade's own is about to start a turn: a wake, which is counted on the watcher it's from. Answers
   * whether it goes ahead: a job you stopped is turned away.
   */
  prompt(taskId: string, prompt: string): PromptVerdict
  /** A turn ended, and the session listed the jobs it has: see the module comment. */
  jobsListed(taskId: string, jobs: readonly SessionJob[]): void
  /** The task's session is gone (it failed): its processes and wakeups with it, and its jobs until it resumes. */
  sessionEnded(taskId: string, outcome: string): void
  /** The app launched: every session is gone (see `sessionEnded`). Call it once, before any session starts. */
  relaunched(): void
  /**
   * You asked to stop a watcher: it's marked as yours to stop, and a job stops at once. Answers what the runner does
   * next, or undefined for a watcher that isn't live (there's nothing to stop).
   */
  requestStop(taskId: string, id: string): StopRequest | undefined
}

/** A monitor's input's command, or its WebSocket's address. */
function monitorCommand(input: z.infer<typeof monitorInput>): string {
  return input.command ?? input.ws?.url ?? ''
}

export function createWatcherTracker({ db, emit, now = Date.now }: WatcherTrackerOptions): WatcherTracker {
  const broadcast = (taskId: string): void => {
    emit({ type: EventType.WatchersChanged, taskId, watchers: listWatchers(db, taskId).map(publicWatcher) })
  }

  const isLive = (watcher: StoredWatcher): boolean => LIVE_WATCHER_STATES.includes(watcher.state)

  /** Ends a watcher: it's no longer due, and it says how it ended. */
  const ending = (state: WatcherState, outcome: string): WatcherChange => ({
    state,
    outcome,
    nextDueAt: null,
    endedAt: now(),
  })

  /** How a monitor or command that the SDK says was stopped came to stop. */
  const stoppedHow = (watcher: StoredWatcher): string => {
    if (watcher.stoppedByYou) return STOPPED_BY_YOU
    if (watcher.expiresAt !== null && now() >= watcher.expiresAt - TIMEOUT_SLACK_MS) return TIMED_OUT
    return STOPPED_BY_AGENT
  }

  /** Ends a task's watcher the way the SDK says its task ended; answers whether it had one live to end. */
  const endTask = (watcher: StoredWatcher, status: string, summary: string): boolean => {
    if (!isLive(watcher)) return false
    switch (status) {
      case TaskOutcome.Completed:
        updateWatcher(db, watcher.id, ending(WatcherState.Finished, summary))
        return true
      case TaskOutcome.Failed:
        updateWatcher(db, watcher.id, ending(WatcherState.Failed, summary))
        return true
      case TaskOutcome.Stopped:
        updateWatcher(db, watcher.id, ending(WatcherState.Stopped, stoppedHow(watcher)))
        return true
      default:
        return false
    }
  }

  /** A monitor or command woke the agent: count it, and keep what it last reported. */
  const noteTaskWake = (taskId: string, notice: TaskNotice): boolean => {
    const watcher = findWatcherBySdkId(db, taskId, notice.taskId, TASK_KINDS)
    if (watcher === undefined) return false
    const line = notice.event === null ? null : lastLine(notice.event)
    updateWatcher(db, watcher.id, {
      wakes: watcher.wakes + 1,
      lastWokeAt: now(),
      ...(line === null ? {} : { lastOutput: line }),
    })
    if (notice.status !== null) endTask(watcher, notice.status, notice.summary ?? '')
    return true
  }

  /** A job fired with `prompt`: the live job of the task with that prompt, due soonest, if there is one. */
  const firedJob = (taskId: string, prompt: string): StoredWatcher | undefined =>
    listWatchers(db, taskId)
      .filter((watcher) => JOB_KINDS.includes(watcher.kind) && isLive(watcher) && watcher.detail === prompt)
      .sort((a, b) => (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity))[0]

  const noteJobFired = (job: StoredWatcher): void => {
    const woke = { wakes: job.wakes + 1, lastWokeAt: now() }
    if (job.kind === WatcherKind.Wakeup || !job.recurring) {
      updateWatcher(db, job.id, { ...woke, ...ending(WatcherState.Finished, FIRED) })
      return
    }
    const next = job.cron === null ? null : nextCronTime(job.cron, now())
    updateWatcher(db, job.id, { ...woke, state: WatcherState.Scheduled, nextDueAt: next })
  }

  /** Whether `prompt` is a fire of a job of the task's you stopped. */
  const isStoppedJob = (taskId: string, prompt: string): boolean =>
    listWatchers(db, taskId).some(
      (watcher) =>
        JOB_KINDS.includes(watcher.kind) &&
        watcher.stoppedByYou &&
        watcher.state === WatcherState.Stopped &&
        watcher.detail === prompt,
    )

  /** The session's processes and wakeups are gone, and its jobs until it resumes. Answers whether anything changed. */
  const endWithSession = (watcher: StoredWatcher, outcome: string): boolean => {
    if (!isLive(watcher)) return false
    if (watcher.kind === WatcherKind.Cron) {
      if (watcher.state === WatcherState.Suspended) return false
      updateWatcher(db, watcher.id, { state: WatcherState.Suspended })
      return true
    }
    updateWatcher(db, watcher.id, ending(WatcherState.Stopped, outcome))
    return true
  }

  const addMonitor = (taskId: string, event: SubagentStartedEvent, call: ToolCallEvent): void => {
    const input = monitorInput.catch({}).parse(call.input)
    const timeout = Math.min(input.timeout_ms ?? MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS)
    const started = now()
    addWatcher(
      db,
      {
        taskId,
        kind: WatcherKind.Monitor,
        toolUseId: event.toolUseId,
        sdkId: event.sdkTaskId,
        label: input.description ?? event.description,
        detail: monitorCommand(input),
        cron: null,
        schedule: null,
        recurring: true,
        state: WatcherState.Running,
        nextDueAt: null,
        expiresAt: started + timeout,
      },
      started,
    )
  }

  const addCommand = (taskId: string, event: SubagentStartedEvent, call: ToolCallEvent | undefined): void => {
    const input = bashInput.catch({}).parse(call?.input ?? {})
    const command = input.command ?? ''
    addWatcher(
      db,
      {
        taskId,
        kind: WatcherKind.Command,
        toolUseId: event.toolUseId,
        sdkId: event.sdkTaskId,
        label: input.description ?? (event.description === '' ? command : event.description),
        detail: command,
        cron: null,
        schedule: null,
        recurring: false,
        state: WatcherState.Running,
        nextDueAt: null,
        expiresAt: null,
      },
      now(),
    )
  }

  const addWakeup = (taskId: string, call: ToolCallEvent, details: unknown): boolean => {
    const input = wakeupInput.catch({}).parse(call.input)
    if (input.stop === true) {
      let changed = false
      for (const watcher of listWatchers(db, taskId)) {
        if (watcher.kind !== WatcherKind.Wakeup || !isLive(watcher)) continue
        updateWatcher(db, watcher.id, ending(WatcherState.Stopped, CANCELLED_BY_AGENT))
        changed = true
      }
      return changed
    }
    const result = wakeupResult.safeParse(details)
    if (!result.success) return false
    addWatcher(
      db,
      {
        taskId,
        kind: WatcherKind.Wakeup,
        toolUseId: call.toolUseId,
        sdkId: null,
        label: input.reason ?? 'Wakeup',
        detail: input.prompt ?? '',
        cron: null,
        schedule: null,
        recurring: false,
        state: WatcherState.Scheduled,
        nextDueAt: result.data.scheduledFor,
        expiresAt: null,
      },
      now(),
    )
    return true
  }

  const addCron = (taskId: string, call: ToolCallEvent, details: unknown): boolean => {
    const input = cronInput.safeParse(call.input)
    const result = cronResult.safeParse(details)
    if (!input.success || !result.success) return false
    const { cron, prompt } = input.data
    const started = now()
    addWatcher(
      db,
      {
        taskId,
        kind: WatcherKind.Cron,
        toolUseId: call.toolUseId,
        sdkId: result.data.id,
        label: lastLine(prompt.split('\n').find((line) => line.trim() !== '') ?? '') ?? prompt,
        detail: prompt,
        cron,
        schedule: result.data.humanSchedule ?? cron,
        recurring: result.data.recurring ?? true,
        state: WatcherState.Scheduled,
        nextDueAt: nextCronTime(cron, started),
        expiresAt: null,
      },
      started,
    )
    return true
  }

  const deleteJob = (taskId: string, call: ToolCallEvent): boolean => {
    const input = cronDeleteInput.safeParse(call.input)
    if (!input.success) return false
    const job = findWatcherBySdkId(db, taskId, input.data.id, JOB_KINDS)
    if (job === undefined || !isLive(job)) return false
    updateWatcher(db, job.id, ending(WatcherState.Stopped, CANCELLED_BY_AGENT))
    return true
  }

  return {
    taskStarted(taskId, event) {
      if (event.taskType !== 'local_bash') return
      const call = getToolCall(db, taskId, event.toolUseId)
      if (call?.name === MONITOR_TOOL) addMonitor(taskId, event, call)
      else addCommand(taskId, event, call)
      broadcast(taskId)
    },

    toolResult(taskId, call, event) {
      if (event.isError) return
      let changed = false
      switch (call.name) {
        case MONITOR_TOOL: {
          // The SDK's own account of the watch's timeout, or that it has none.
          const watcher = listWatchers(db, taskId).find(({ toolUseId }) => toolUseId === call.toolUseId)
          const result = monitorResult.safeParse(event.details)
          if (watcher === undefined || !result.success) return
          const { persistent, timeoutMs } = result.data
          if (persistent === true) changed = updateWatcher(db, watcher.id, { expiresAt: null }) !== undefined
          else if (timeoutMs !== undefined && timeoutMs > 0) {
            changed = updateWatcher(db, watcher.id, { expiresAt: watcher.startedAt + timeoutMs }) !== undefined
          }
          break
        }
        case SCHEDULE_WAKEUP_TOOL:
          changed = addWakeup(taskId, call, event.details)
          break
        case CRON_CREATE_TOOL:
          changed = addCron(taskId, call, event.details)
          break
        case CRON_DELETE_TOOL:
          changed = deleteJob(taskId, call)
          break
      }
      if (changed) broadcast(taskId)
    },

    taskFinished(taskId, event) {
      const watcher = findWatcherBySdkId(db, taskId, event.sdkTaskId, TASK_KINDS)
      if (watcher !== undefined && endTask(watcher, event.outcome, event.summary)) broadcast(taskId)
    },

    prompt(taskId, prompt) {
      const notices = parseTaskNotices(prompt)
      if (notices.length > 0) {
        let changed = false
        for (const notice of notices) changed = noteTaskWake(taskId, notice) || changed
        if (changed) broadcast(taskId)
        return PromptVerdict.Allow
      }
      const job = firedJob(taskId, prompt)
      if (job !== undefined) {
        noteJobFired(job)
        broadcast(taskId)
        return PromptVerdict.Allow
      }
      return isStoppedJob(taskId, prompt) ? PromptVerdict.Block : PromptVerdict.Allow
    },

    jobsListed(taskId, jobs) {
      let changed = false
      const watchers = listWatchers(db, taskId)
      const claimed = new Set(watchers.flatMap(({ sdkId }) => (sdkId === null ? [] : [sdkId])))
      for (const watcher of watchers) {
        if (!JOB_KINDS.includes(watcher.kind) || !isLive(watcher)) continue
        let { sdkId } = watcher
        // A wakeup is a one-off job to the SDK, which only names it here: the first unclaimed one with its prompt.
        if (sdkId === null) {
          const job = jobs.find(
            ({ id, recurring, prompt }) => !recurring && prompt === watcher.detail && !claimed.has(id),
          )
          if (job === undefined) continue
          sdkId = job.id
          claimed.add(sdkId)
          updateWatcher(db, watcher.id, { sdkId })
          changed = true
        }
        const listed = jobs.some(({ id }) => id === sdkId)
        if (!listed) {
          updateWatcher(db, watcher.id, ending(WatcherState.Finished, NO_LONGER_SCHEDULED))
          changed = true
        } else if (watcher.state === WatcherState.Suspended) {
          const next = watcher.cron === null ? watcher.nextDueAt : nextCronTime(watcher.cron, now())
          updateWatcher(db, watcher.id, { state: WatcherState.Scheduled, nextDueAt: next })
          changed = true
        }
      }
      if (changed) broadcast(taskId)
    },

    sessionEnded(taskId, outcome) {
      let changed = false
      for (const watcher of listWatchers(db, taskId)) changed = endWithSession(watcher, outcome) || changed
      if (changed) broadcast(taskId)
    },

    relaunched() {
      const changed = new Set<string>()
      for (const watcher of listLiveWatchers(db)) {
        if (endWithSession(watcher, STOPPED_BY_RELAUNCH)) changed.add(watcher.taskId)
      }
      for (const taskId of changed) broadcast(taskId)
    },

    requestStop(taskId, id) {
      const watcher = getWatcher(db, id)
      if (watcher?.taskId !== taskId || !isLive(watcher)) return undefined
      if (TASK_KINDS.includes(watcher.kind) && watcher.sdkId !== null) {
        updateWatcher(db, id, { stoppedByYou: true })
        return { action: StopAction.StopTask, sdkTaskId: watcher.sdkId }
      }
      updateWatcher(db, id, { stoppedByYou: true, ...ending(WatcherState.Stopped, STOPPED_BY_YOU) })
      broadcast(taskId)
      return { action: StopAction.None }
    },
  }
}
