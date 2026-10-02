import { describe, expect, it } from 'vitest'
import { AgentErrorKind } from '../../shared/domain'
import { classifyAgentError, type AgentErrorFacts } from './error-classification'

const facts = (overrides: Partial<AgentErrorFacts>): AgentErrorFacts => ({
  status: null,
  code: null,
  message: '',
  ...overrides,
})

describe('classifyAgentError', () => {
  it.each([
    ['overloaded (529)', { status: 529, code: 'overloaded' }],
    ['a server error (500)', { status: 500, code: 'server_error' }],
    ['a bad gateway with no name', { status: 502 }],
    ['a rate limit (429)', { status: 429, code: 'rate_limit' }],
    ['a request timeout (408)', { status: 408 }],
    ['a conflict (409)', { status: 409 }],
    ['overloaded without a status', { code: 'overloaded' }],
    ['overloaded while the usage limit rejects requests', { status: 529, code: 'overloaded', limitRejected: true }],
  ])('calls %s transient', (_, overrides) => {
    expect(classifyAgentError(facts(overrides))).toBe(AgentErrorKind.Transient)
  })

  it.each([
    ['a missing model (404)', { status: 404, code: 'model_not_found' }],
    ['an organization that turned off subscription access', { status: 403, code: 'oauth_org_not_allowed' }],
    ['an invalid request (400)', { status: 400, code: 'invalid_request' }],
    ['a reply too long', { code: 'max_output_tokens' }],
    ['a turn out of turns', { message: 'Reached the maximum number of turns.' }],
    ['a crashed process', { message: 'The agent stopped: spawn ENOENT' }],
  ])('calls %s permanent', (_, overrides) => {
    expect(classifyAgentError(facts(overrides))).toBe(AgentErrorKind.Permanent)
  })

  it.each([
    ['a usage limit message', { status: 429, code: 'rate_limit', message: "You've hit your limit · resets 3pm" }],
    ['a usage limit after the API prefix', { message: "API Error: You're out of usage credits" }],
    ['a billing error', { status: 400, code: 'billing_error', message: 'Credit balance is too low' }],
    ['a rate limit once the usage limit rejects requests', { code: 'rate_limit', limitRejected: true }],
    ['a 429 once the usage limit rejects requests', { status: 429, limitRejected: true }],
  ])('calls %s a usage limit', (_, overrides) => {
    expect(classifyAgentError(facts(overrides))).toBe(AgentErrorKind.UsageLimit)
  })

  it.each([
    ['a DNS failure', { message: 'getaddrinfo ENOTFOUND api.anthropic.com' }],
    ['a refused connection', { code: 'unknown', message: 'connect ECONNREFUSED 127.0.0.1:443' }],
    ['a failed fetch', { message: 'TypeError: fetch failed' }],
    ['a connection error', { message: 'API Error: Connection error.' }],
  ])('calls %s offline', (_, overrides) => {
    expect(classifyAgentError(facts(overrides))).toBe(AgentErrorKind.Offline)
  })

  // The real shapes, as the bundled Claude Code words them for an SDK session (docs/sdk-notes.md §1, "Logged out").
  it.each([
    ['no login at all', { code: 'authentication_failed', message: 'Not logged in · Please run /login' }],
    [
      'an expired login it couldn’t refresh',
      {
        code: 'authentication_failed',
        message: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      },
    ],
    [
      'a 401 from the API',
      {
        status: 401,
        code: 'authentication_failed',
        message:
          'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_011Sample"}',
      },
    ],
    [
      'a revoked login',
      {
        code: 'authentication_failed',
        message: 'Your account does not have access to Claude. Please login again or contact your administrator.',
      },
    ],
    [
      'an interactive session’s expired login',
      { code: 'authentication_failed', message: 'Login expired · Please run /login' },
    ],
    ['a revoked token', { message: 'OAuth token revoked · Please run /login' }],
    ['an expired token, with no name for it', { message: 'OAuth token has expired. Please obtain a new token.' }],
    ['an invalid key Claude Code’s login made', { message: 'Invalid API key · Please run /login' }],
    ['a 401 with no name or words for it', { status: 401 }],
    ['the API’s own error type', { message: 'API Error: {"type":"error","error":{"type":"authentication_error"}}' }],
    [
      'a Console key the organization turned off',
      {
        code: 'authentication_failed',
        message: 'Your organization has disabled API key authentication · Sign in again with your claude.ai account',
      },
    ],
    ['a sign-in failure before a usage limit', { status: 401, code: 'authentication_failed', limitRejected: true }],
  ])('calls %s logged out', (_, overrides) => {
    expect(classifyAgentError(facts(overrides))).toBe(AgentErrorKind.LoggedOut)
  })

  it.each([
    [
      'an external API key',
      { status: 401, code: 'authentication_failed', message: 'Invalid API key · Fix external API key' },
    ],
    [
      'an organization that turned off the key in the environment',
      {
        code: 'invalid_request',
        message:
          'Your organization has disabled API key authentication · Unset ANTHROPIC_API_KEY and run /login to sign in with your claude.ai account',
      },
    ],
    [
      'expired AWS credentials',
      {
        status: 403,
        code: 'authentication_failed',
        message: 'AWS credentials expired or invalid · refresh your AWS credentials and retry · API Error: 403',
      },
    ],
    [
      'Google Cloud credentials',
      { status: 401, code: 'authentication_failed', message: 'Google Cloud authentication failed · API Error: 401' },
    ],
    [
      'a gateway that refused the account',
      {
        status: 403,
        code: 'authentication_failed',
        message: "Gateway refused the request · signing in again won't change this · API Error: 403",
      },
    ],
  ])('doesn’t call %s logged out', (_, overrides) => {
    expect(classifyAgentError(facts(overrides))).toBe(AgentErrorKind.Permanent)
  })

  it('calls another process refreshing the login transient, not logged out', () => {
    const message =
      'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again'
    expect(classifyAgentError(facts({ code: 'server_error', message }))).toBe(AgentErrorKind.Transient)
  })

  it('calls a connection-like message with an HTTP status by its status', () => {
    expect(classifyAgentError(facts({ status: 503, message: 'network is busy' }))).toBe(AgentErrorKind.Transient)
  })
})
