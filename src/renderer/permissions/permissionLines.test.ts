import { describe, expect, it } from 'vitest'
import { PermissionRequestState, type PermissionRequest } from '../../shared/domain'
import { samplePermissionRequest } from '../store/test-bridge'
import {
  NO_PERMISSION_LINES,
  PermissionLineScope,
  PermissionLineState,
  permissionLineText,
} from './permissionLineModel'
import { grantedRuleSubject, permissionLinesByToolUse, requestPermissionLine } from './permissionLines'

function request(id: string, patch: Partial<PermissionRequest> = {}): PermissionRequest {
  return { ...samplePermissionRequest(id, 't1'), ...patch }
}

function closed(id: string, state: PermissionRequestState, patch: Partial<PermissionRequest> = {}): PermissionRequest {
  return request(id, { state, closedAt: 4_000, ...patch })
}

describe("a request's line", () => {
  it('waits on you while its card is open', () => {
    expect(requestPermissionLine(request('p1'))).toEqual({ state: PermissionLineState.Waiting, subject: null })
  })

  it('says Allowed once for a call allowed with no rule', () => {
    expect(requestPermissionLine(closed('p1', PermissionRequestState.Allowed))).toEqual({
      state: PermissionLineState.Allowed,
      scope: PermissionLineScope.Once,
      subject: null,
    })
  })

  it('names the rule Allow for this task granted', () => {
    const line = requestPermissionLine(
      closed('p1', PermissionRequestState.Allowed, { grantedRule: { toolName: 'Bash', ruleContent: 'npm test *' } }),
    )
    expect(line).toEqual({
      state: PermissionLineState.Allowed,
      scope: PermissionLineScope.Task,
      subject: 'npm test commands',
    })
    expect(permissionLineText(line)).toBe('Allowed for this task: npm test commands')
  })

  it('carries the note of a denial, or none', () => {
    expect(requestPermissionLine(closed('p1', PermissionRequestState.Denied, { denyNote: 'Keep dist.' }))).toEqual({
      state: PermissionLineState.Denied,
      subject: null,
      note: 'Keep dist.',
    })
    expect(permissionLineText(requestPermissionLine(closed('p1', PermissionRequestState.Denied)))).toBe('Denied')
  })

  it('says Withdrawn for a request that closed without an answer', () => {
    expect(requestPermissionLine(closed('p1', PermissionRequestState.Withdrawn))).toEqual({
      state: PermissionLineState.Withdrawn,
      subject: null,
    })
  })
})

describe('what a granted rule covers', () => {
  it('is the prefix and "commands", the older colon form too', () => {
    expect(grantedRuleSubject({ toolName: 'Bash', ruleContent: 'npm run lint *' })).toBe('npm run lint commands')
    expect(grantedRuleSubject({ toolName: 'Bash', ruleContent: 'npm run lint:*' })).toBe('npm run lint commands')
  })

  it('is the command itself for a rule without a prefix', () => {
    expect(grantedRuleSubject({ toolName: 'Bash', ruleContent: 'touch a(1).txt' })).toBe('touch a(1).txt')
  })

  it("is the tool's name for a whole tool, as the log shows it", () => {
    expect(grantedRuleSubject({ toolName: 'Edit' })).toBe('Edit')
    expect(grantedRuleSubject({ toolName: 'mcp__glade__ask', ruleContent: '' })).toBe('ask')
  })
})

describe("each call's line, by its tool_use id", () => {
  it('has none for a task with no requests, and is the same empty map each time', () => {
    expect(permissionLinesByToolUse([])).toBe(NO_PERMISSION_LINES)
    expect(permissionLinesByToolUse([]).size).toBe(0)
  })

  it('finds each request by the call it was about', () => {
    const lines = permissionLinesByToolUse([
      request('p1'),
      closed('p2', PermissionRequestState.Allowed),
      closed('p3', PermissionRequestState.Denied, { denyNote: 'No' }),
      closed('p4', PermissionRequestState.Withdrawn),
    ])

    expect([...lines].map(([toolUseId, line]) => [toolUseId, permissionLineText(line)])).toEqual([
      ['toolu-p1', 'Waiting on you'],
      ['toolu-p2', 'Allowed once'],
      ['toolu-p3', 'Denied: “No”'],
      ['toolu-p4', 'Withdrawn'],
    ])
    expect(lines.get('toolu-nothing')).toBeUndefined()
  })

  it("shows a call's latest request when it had several", () => {
    const lines = permissionLinesByToolUse([
      closed('first', PermissionRequestState.Withdrawn, { toolUseId: 'toolu-x' }),
      closed('second', PermissionRequestState.Allowed, { toolUseId: 'toolu-x', createdAt: 3_500 }),
    ])

    expect(permissionLineText(lines.get('toolu-x') ?? { state: PermissionLineState.Waiting, subject: null })).toBe(
      'Allowed once',
    )
    expect(lines.size).toBe(1)
  })

  it('keeps showing the request still waiting on you, the first of them, over ones answered after it', () => {
    const lines = permissionLinesByToolUse([
      closed('before', PermissionRequestState.Denied, { toolUseId: 'toolu-x' }),
      request('waiting', { toolUseId: 'toolu-x', createdAt: 3_100 }),
      closed('after', PermissionRequestState.Allowed, { toolUseId: 'toolu-x', createdAt: 3_200 }),
      request('also-waiting', { toolUseId: 'toolu-x', createdAt: 3_300 }),
    ])

    expect(lines.get('toolu-x')).toEqual({ state: PermissionLineState.Waiting, subject: null })
  })
})
