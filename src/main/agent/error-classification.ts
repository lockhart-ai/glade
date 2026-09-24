/**
 * Sorts the errors that stop a task's agent into kinds (`AgentErrorKind`): transient, permanent, a usage limit, or
 * offline. Pure, so the rules are easy to test.
 *
 * Glade never retries a transient error itself: Claude Code already retries failed API requests with backoff before it
 * gives up, and tells us about each retry (`system/api_retry`, `docs/sdk-notes.md`, "Errors and retries"). Retrying
 * again on top would multiply the attempts. The kind says what the error is once those retries are spent, for the
 * error card now and for the usage limit and offline screens (P3-04).
 */
import { USAGE_LIMIT_ERROR_PREFIXES } from '@anthropic-ai/claude-agent-sdk'
import { AgentErrorKind } from '../../shared/domain'

/** What Glade knows about an error. */
export interface AgentErrorFacts {
  /** The API's HTTP status; null when there was none (a connection error, or not the API's). */
  readonly status: number | null
  /** The SDK's name for the error (`SDKAssistantMessageError`), e.g. `overloaded`; null when it gave none. */
  readonly code: string | null
  /** The error's text. */
  readonly message: string
  /**
   * Whether the SDK said the account's usage limit is rejecting requests (a `rate_limit_event` with status `rejected`)
   * before the error. A 429 then means the limit ran out, not a passing rate limit. False when it didn't say.
   */
  readonly limitRejected?: boolean
}

/** The SDK's error names for errors that go away if you wait. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(['overloaded', 'server_error', 'rate_limit'])

/** The SDK's error names for running out of usage or credits. */
const USAGE_LIMIT_CODES: ReadonlySet<string> = new Set(['billing_error'])

/** HTTP statuses below 500 that go away if you wait: request timeout, conflict, and too many requests. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 429])

/** What a request that never reached the API says. */
const CONNECTION_FAILURE =
  /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN)\b|fetch failed|connection error|network/i

function isUsageLimit({ status, code, message, limitRejected = false }: AgentErrorFacts): boolean {
  if (code !== null && USAGE_LIMIT_CODES.has(code)) return true
  if (limitRejected && (code === 'rate_limit' || status === 429)) return true
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => message.includes(prefix))
}

function isOffline({ status, code, message }: AgentErrorFacts): boolean {
  return status === null && (code === null || code === 'unknown') && CONNECTION_FAILURE.test(message)
}

function isTransient({ status, code }: AgentErrorFacts): boolean {
  if (code !== null && TRANSIENT_CODES.has(code)) return true
  return status !== null && (TRANSIENT_STATUSES.has(status) || status >= 500)
}

/** The kind of an error: a usage limit, offline, transient, or else permanent, checked in that order. */
export function classifyAgentError(facts: AgentErrorFacts): AgentErrorKind {
  if (isUsageLimit(facts)) return AgentErrorKind.UsageLimit
  if (isOffline(facts)) return AgentErrorKind.Offline
  if (isTransient(facts)) return AgentErrorKind.Transient
  return AgentErrorKind.Permanent
}
