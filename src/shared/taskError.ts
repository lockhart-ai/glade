/**
 * How the app words what stopped a task's agent (`TaskError`): the chat's error card, the task list's "Error: …" status
 * line, and the tool log's failed API row (`docs/design/html/16-error.html`).
 */
import { AgentErrorKind, TaskActivity, TaskErrorSource, TaskState, type Task, type TaskError } from './domain'
import { sandboxFailureReason } from './sandboxFailure'
import { startupFailureMessage } from './startupFailure'

/** The SDK's name for an error, in words: `server_error` → `server error`. Null for none, or `unknown`. */
function codeName(code: string | null): string | null {
  return code === null || code === 'unknown' ? null : code.replaceAll('_', ' ')
}

/** An API error as the card and the tool log name it: `529 overloaded`, `502`, `overloaded`; null for neither. */
export function apiErrorLabel(error: Pick<TaskError, 'status' | 'code'>): string | null {
  const name = codeName(error.code)
  if (error.status === null) return name
  return name === null ? String(error.status) : `${String(error.status)} ${name}`
}

/** What went wrong, in a few words, for the task list: `API overloaded`, `can’t reach the API`. */
export function errorHeadline(error: TaskError | null): string {
  if (error === null) return 'the agent stopped'
  switch (error.kind) {
    case AgentErrorKind.Offline:
      return 'can’t reach the API'
    case AgentErrorKind.UsageLimit:
      return 'usage limit reached'
    case AgentErrorKind.LoggedOut:
      return 'logged out of Claude'
    case AgentErrorKind.Transient:
    case AgentErrorKind.Permanent:
    case AgentErrorKind.SafetyRefusal:
      // A safety refusal is paired with `TaskErrorSource.Refusal`, which the source switch below words.
      break
  }
  switch (error.source) {
    case TaskErrorSource.Session:
      return 'the agent process stopped'
    case TaskErrorSource.Startup:
      return 'Claude Code couldn’t start'
    case TaskErrorSource.Turn:
      return 'the turn failed'
    case TaskErrorSource.Refusal:
      return 'declined by a safety check'
    case TaskErrorSource.Sandbox:
      return 'the sandbox couldn’t start'
    case TaskErrorSource.Api: {
      const name = codeName(error.code)
      if (name !== null) return `API ${name}`
      return error.status === null ? 'API error' : `API error ${String(error.status)}`
    }
  }
}

/**
 * The task list's status line for a task stopped by an error: `Error: API overloaded · retry?`, or, logged out of
 * Claude, `Error: logged out of Claude · log in?`.
 */
export function errorStatusLine(error: TaskError | null): string {
  const next = error?.kind === AgentErrorKind.LoggedOut ? 'log in' : 'retry'
  return `Error: ${errorHeadline(error)} · ${next}?`
}

/**
 * Whether a lost login stops the task now (#409): it's active, stopped on an error, and that error is a lost login.
 * The tasks Retry all retries.
 */
export function isStoppedLoggedOut(task: Task | undefined): boolean {
  return (
    task?.state === TaskState.Active &&
    task.activity === TaskActivity.Error &&
    task.error?.kind === AgentErrorKind.LoggedOut
  )
}

/** The title of the card a lost login stopped a task with (`docs/design/html/38-logged-out.html`). */
export const LOGGED_OUT_TITLE = 'You’re logged out of Claude'

/**
 * How the error card opens: `lead`, then, when there is one, `label` in monospace and a full stop, as in "The API
 * returned `529 overloaded`."
 */
export interface ErrorOpening {
  readonly lead: string
  readonly label: string | null
}

/** How the error card opens: what happened. */
export function errorOpening(error: TaskError | null): ErrorOpening {
  if (error === null) return { lead: 'The agent stopped on an error.', label: null }
  if (error.kind === AgentErrorKind.Offline) return { lead: 'Glade couldn’t reach the API.', label: null }
  if (error.kind === AgentErrorKind.LoggedOut) {
    return { lead: 'Claude Code’s login expired or isn’t there, so the agent couldn’t carry on.', label: null }
  }
  switch (error.source) {
    case TaskErrorSource.Session:
      return { lead: 'The agent’s process stopped unexpectedly.', label: null }
    case TaskErrorSource.Startup: {
      // A reason Glade doesn't know (a newer SDK's) is named as the SDK gives it.
      const message = error.code === null ? null : startupFailureMessage(error.code)
      if (message !== null) return { lead: message, label: null }
      return error.code === null
        ? { lead: 'Claude Code couldn’t start.', label: null }
        : { lead: 'Claude Code couldn’t start: ', label: error.code }
    }
    case TaskErrorSource.Turn:
      return { lead: 'The turn ended on an error.', label: null }
    case TaskErrorSource.Refusal: {
      const category = codeName(error.code)
      return category === null
        ? { lead: 'The request was declined by a safety check.', label: null }
        : { lead: 'The request was declined by a safety check: ', label: category }
    }
    case TaskErrorSource.Sandbox: {
      // Claude Code's own failure names why after its opening words; any other is the reason as it is.
      const reason = sandboxFailureReason(error.details) ?? error.details.trim()
      return reason === ''
        ? { lead: 'The sandbox couldn’t start.', label: null }
        : { lead: 'The sandbox couldn’t start: ', label: reason }
    }
    case TaskErrorSource.Api: {
      const label = apiErrorLabel(error)
      return label === null ? { lead: 'An API request failed.', label: null } : { lead: 'The API returned ', label }
    }
  }
}

/** A span of time in words, for the retries: `40 seconds`, `1 minute`, `2 minutes`. */
export function spanLabel(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`
}

/** What happened after the error: "Glade retried 3 times over 2 minutes, then paused the task." */
export function retriesSentence(error: Pick<TaskError, 'retries' | 'retryingMs'> | null): string {
  if (error === null || error.retries === 0) return 'Glade paused the task.'
  const times = error.retries === 1 ? 'once' : `${String(error.retries)} times`
  return `Glade retried ${times} over ${spanLabel(error.retryingMs)}, then paused the task.`
}

/** The error card's reassurance. */
export const NOTHING_LOST = 'Nothing is lost: the chat, tool log and files are as they were.'

/** The argument of the tool log's failed API row: which request failed, `request 3 of 3`. */
export function apiRowArgument(error: Pick<TaskError, 'retries'>): string {
  const requests = String(error.retries + 1)
  return `request ${requests} of ${requests}`
}

/** The result line of the tool log's failed API row: `529 overloaded · task paused`. */
export function apiRowResult(error: Pick<TaskError, 'status' | 'code'>): string {
  return `${apiErrorLabel(error) ?? 'Request failed'} · task paused`
}

/** What the working line says while a failed API request is retried: `Retrying (2 of 10)…`. */
export function retryingLabel(retry: { readonly attempt: number; readonly maxRetries: number }): string {
  return `Retrying (${String(retry.attempt)} of ${String(retry.maxRetries)})…`
}
