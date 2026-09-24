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
    ['a failed sign-in (401)', { status: 401, code: 'authentication_failed' }],
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

  it('calls a connection-like message with an HTTP status by its status', () => {
    expect(classifyAgentError(facts({ status: 503, message: 'network is busy' }))).toBe(AgentErrorKind.Transient)
  })
})
