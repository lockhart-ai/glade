/**
 * How the app words a paused turn (`TaskPause`, `docs/design/html/17-usage-limit.html`): the app-wide banner across
 * the top of the window, the task list's status line, the header's pill and the chat's paused line.
 */
import { PauseReason, TaskActivity, TaskState, type EpochMs, type Task, type TaskPause } from '../../shared/domain'
import { clockTime } from '../chat/chatModel'
import { formatDay } from '../task-header/headerModel'

/** A task whose turn is paused, with its pause. */
export interface PausedTask extends Task {
  readonly pause: TaskPause
}

/** Whether a task's turn is paused: it's active, and its agent waits for the limit to reset or the network. */
export function isPaused(task: Task): task is PausedTask {
  return task.state === TaskState.Active && task.activity === TaskActivity.Paused && task.pause !== null
}

/** Every paused task, across every workspace, the one that resumes first first. */
export function pausedTasks(tasks: Readonly<Record<string, Task>>): PausedTask[] {
  return Object.values(tasks)
    .filter(isPaused)
    .sort((a, b) => a.pause.resumesAt - b.pause.resumesAt || a.createdAt - b.createdAt)
}

/** When a pause resumes, as the app says it: `11:42` today, `Sep 27 11:42` on another day. */
export function resumeTime(at: EpochMs, now: EpochMs): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return sameDay ? clockTime(at) : `${formatDay(at)} ${clockTime(at)}`
}

/** The task list's status line for a paused task: `Paused: usage limit · resumes 11:42`, `Paused: offline`. */
export function pausedStatusLine(pause: TaskPause, now: EpochMs): string {
  switch (pause.reason) {
    case PauseReason.UsageLimit:
      return `Paused: usage limit · resumes ${resumeTime(pause.resumesAt, now)}`
    case PauseReason.Offline:
      return 'Paused: offline'
  }
}

/** The chat's paused line: `Paused · resumes at 11:42`, `Paused · resumes when the network is back`. */
export function pausedChatLine(pause: TaskPause, now: EpochMs): string {
  switch (pause.reason) {
    case PauseReason.UsageLimit:
      return `Paused · resumes at ${resumeTime(pause.resumesAt, now)}`
    case PauseReason.Offline:
      return 'Paused · resumes when the network is back'
  }
}

/** What the input bar's field says while the task is paused. */
export const PAUSED_PLACEHOLDER = 'Messages are queued until the task resumes…'

/** The banner's words: a bold `title`, then the `text` after it. */
export interface BannerText {
  readonly title: string
  readonly text: string
}

/** `1 task is paused and will resume on its own`, `3 tasks are paused and will resume on their own`. */
function willResume(count: number): string {
  return count === 1
    ? '1 task is paused and will resume on its own'
    : `${String(count)} tasks are paused and will resume on their own`
}

/**
 * The banner's words for the paused tasks, or null when none is paused: "**Usage limit reached.** 3 tasks are paused
 * and will resume on their own at 11:42." When they resume at different times, it gives the last, by when all of them
 * will have. Offline, they resume when the network is back; with some of each, it doesn't say when.
 */
export function bannerText(paused: readonly PausedTask[], now: EpochMs): BannerText | null {
  if (paused.length === 0) return null
  const limited = paused.filter((task) => task.pause.reason === PauseReason.UsageLimit)
  const lead = willResume(paused.length)
  if (limited.length === paused.length) {
    const last = Math.max(...limited.map((task) => task.pause.resumesAt))
    return { title: 'Usage limit reached.', text: `${lead} at ${resumeTime(last, now)}.` }
  }
  if (limited.length === 0) return { title: 'Can’t reach the API.', text: `${lead} when the network is back.` }
  return { title: 'Usage limit reached, and can’t reach the API.', text: `${lead}.` }
}

/** Whether the banner offers Switch model: only for a usage limit, which another model may not have hit. */
export function offersSwitchModel(paused: readonly PausedTask[]): boolean {
  return paused.some((task) => task.pause.reason === PauseReason.UsageLimit)
}

/** The paused tasks Switch model moves to another model and resumes: the ones a usage limit paused. */
export function switchableTasks(paused: readonly PausedTask[]): PausedTask[] {
  return paused.filter((task) => task.pause.reason === PauseReason.UsageLimit)
}

/** Why a task is paused, in a few words, for the banner's details. */
export function pauseReasonLabel(reason: PauseReason): string {
  switch (reason) {
    case PauseReason.UsageLimit:
      return 'Usage limit'
    case PauseReason.Offline:
      return 'Offline'
  }
}
