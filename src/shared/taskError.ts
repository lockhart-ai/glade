/**
 * How the app words what stopped a task's agent (`TaskError`): the chat's error card, the task list's "Error: …" status
 * line, and the tool log's failed API row (`docs/design/html/16-error.html`).
 */
import { AgentErrorKind, TaskErrorSource, type TaskError } from './domain'

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
    case AgentErrorKind.Transient:
    case AgentErrorKind.Permanent:
      break
  }
  switch (error.source) {
    case TaskErrorSource.Session:
      return 'the agent process stopped'
    case TaskErrorSource.Turn:
      return 'the turn failed'
    case TaskErrorSource.Api: {
      const name = codeName(error.code)
      if (name !== null) return `API ${name}`
      return error.status === null ? 'API error' : `API error ${String(error.status)}`
    }
  }
}

/** The task list's status line for a task stopped by an error: `Error: API overloaded · retry?`. */
export function errorStatusLine(error: TaskError | null): string {
  return `Error: ${errorHeadline(error)} · retry?`
}

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
  switch (error.source) {
    case TaskErrorSource.Session:
      return { lead: 'The agent’s process stopped unexpectedly.', label: null }
    case TaskErrorSource.Turn:
      return { lead: 'The turn ended on an error.', label: null }
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
