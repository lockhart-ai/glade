import { describe, expect, it } from 'vitest'
import { AgentErrorKind, TaskErrorSource, type TaskError } from './domain'
import {
  apiErrorLabel,
  apiRowArgument,
  apiRowResult,
  errorHeadline,
  errorOpening,
  errorStatusLine,
  retriesSentence,
  retryingLabel,
  spanLabel,
} from './taskError'

const overloaded: TaskError = {
  kind: AgentErrorKind.Transient,
  source: TaskErrorSource.Api,
  status: 529,
  code: 'overloaded',
  details: 'API Error: 529 Overloaded',
  retries: 3,
  retryingMs: 120_000,
}

const error = (overrides: Partial<TaskError>): TaskError => ({ ...overloaded, ...overrides })

describe('apiErrorLabel', () => {
  it('names an API error by its status and its name, or whichever it has', () => {
    expect(apiErrorLabel({ status: 529, code: 'overloaded' })).toBe('529 overloaded')
    expect(apiErrorLabel({ status: 500, code: 'server_error' })).toBe('500 server error')
    expect(apiErrorLabel({ status: 502, code: null })).toBe('502')
    expect(apiErrorLabel({ status: 502, code: 'unknown' })).toBe('502')
    expect(apiErrorLabel({ status: null, code: 'rate_limit' })).toBe('rate limit')
    expect(apiErrorLabel({ status: null, code: null })).toBeNull()
  })
})

describe('errorHeadline and errorStatusLine', () => {
  it.each([
    [overloaded, 'API overloaded'],
    [error({ code: 'server_error', status: 500 }), 'API server error'],
    [error({ code: null, status: 502 }), 'API error 502'],
    [error({ code: null, status: null, kind: AgentErrorKind.Permanent }), 'API error'],
    [error({ kind: AgentErrorKind.Offline, status: null, code: null }), 'can’t reach the API'],
    [error({ kind: AgentErrorKind.UsageLimit }), 'usage limit reached'],
    [error({ source: TaskErrorSource.Session, kind: AgentErrorKind.Permanent }), 'the agent process stopped'],
    [error({ source: TaskErrorSource.Turn, kind: AgentErrorKind.Permanent }), 'the turn failed'],
    [null, 'the agent stopped'],
  ])('says what went wrong in a few words', (stopped, headline) => {
    expect(errorHeadline(stopped)).toBe(headline)
  })

  it('makes the task list’s status line of it', () => {
    expect(errorStatusLine(overloaded)).toBe('Error: API overloaded · retry?')
  })
})

describe('errorOpening', () => {
  it.each([
    [overloaded, { lead: 'The API returned ', label: '529 overloaded' }],
    [error({ status: null, code: null }), { lead: 'An API request failed.', label: null }],
    [error({ kind: AgentErrorKind.Offline }), { lead: 'Glade couldn’t reach the API.', label: null }],
    [error({ source: TaskErrorSource.Session }), { lead: 'The agent’s process stopped unexpectedly.', label: null }],
    [error({ source: TaskErrorSource.Turn }), { lead: 'The turn ended on an error.', label: null }],
    [null, { lead: 'The agent stopped on an error.', label: null }],
  ])('says what happened', (stopped, opening) => {
    expect(errorOpening(stopped)).toEqual(opening)
  })
})

describe('retries', () => {
  it('words a span of time in seconds, then minutes', () => {
    expect(spanLabel(0)).toBe('1 second')
    expect(spanLabel(40_000)).toBe('40 seconds')
    expect(spanLabel(60_000)).toBe('1 minute')
    expect(spanLabel(118_000)).toBe('2 minutes')
  })

  it('says how often Glade retried before it paused the task', () => {
    expect(retriesSentence(overloaded)).toBe('Glade retried 3 times over 2 minutes, then paused the task.')
    expect(retriesSentence({ retries: 1, retryingMs: 8_000 })).toBe(
      'Glade retried once over 8 seconds, then paused the task.',
    )
    expect(retriesSentence({ retries: 0, retryingMs: 0 })).toBe('Glade paused the task.')
    expect(retriesSentence(null)).toBe('Glade paused the task.')
  })

  it('names the retry in progress', () => {
    expect(retryingLabel({ attempt: 2, maxRetries: 10 })).toBe('Retrying (2 of 10)…')
  })
})

describe('the failed API row', () => {
  it('says which request failed, and how', () => {
    expect(apiRowArgument(overloaded)).toBe('request 4 of 4')
    expect(apiRowArgument({ retries: 0 })).toBe('request 1 of 1')
    expect(apiRowResult(overloaded)).toBe('529 overloaded · task paused')
    expect(apiRowResult({ status: null, code: null })).toBe('Request failed · task paused')
  })
})
