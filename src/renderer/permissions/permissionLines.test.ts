import { describe, expect, it } from 'vitest'
import {
  PermissionMarkKind,
  PermissionRequestState,
  type PermissionMark,
  type PermissionMarkOutcome,
  type PermissionRequest,
} from '../../shared/domain'
import { FolderAccess, OtherAgents, SandboxAskKind, SandboxGrantScope, type SandboxAsk } from '../../shared/sandbox'
import { samplePermissionRequest } from '../store/test-bridge'
import {
  NO_PERMISSION_LINES,
  PermissionLineScope,
  PermissionLineState,
  permissionLineText,
} from './permissionLineModel'
import {
  grantedRuleSubject,
  markPermissionLine,
  permissionLinesByToolUse,
  requestPermissionLine,
} from './permissionLines'
import { setHomeFolder } from '../../shared/homeFolder'

// The sample data's home folder, which paths under it are shown from as `~`.
setHomeFolder('/Users/me')

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

describe("a sandbox request's line", () => {
  const WEB: SandboxAsk = { kind: SandboxAskKind.Folder, path: '/Users/me/code/acme-web', access: FolderAccess.Read }
  const API: SandboxAsk = {
    kind: SandboxAskKind.Folder,
    path: '/Users/me/code/acme-web/src/api',
    access: FolderAccess.ReadWrite,
  }
  const NPM: SandboxAsk = {
    kind: SandboxAskKind.Domain,
    domain: 'registry.npmjs.org',
    command: 'npx openapi-typescript',
    commandDescription: null,
  }
  const OUTSIDE: SandboxAsk = { kind: SandboxAskKind.Outside }
  const text = (patch: Partial<PermissionRequest>): string =>
    permissionLineText(requestPermissionLine(request('p1', patch)))
  const allowed = { state: PermissionRequestState.Allowed, closedAt: 4_000 }

  it('says what it was about in every state, status first', () => {
    expect(text({ sandbox: WEB })).toBe('Waiting on you: read ~/code/acme-web')
    expect(text({ sandbox: OUTSIDE })).toBe('Waiting on you: run outside the sandbox')
    expect(text({ ...allowed, sandbox: WEB, grantedScope: SandboxGrantScope.Task })).toBe(
      'Allowed for this task: read ~/code/acme-web',
    )
    expect(text({ ...allowed, sandbox: API, grantedScope: SandboxGrantScope.Workspace })).toBe(
      'Allowed for this workspace: write to ~/code/acme-web/src/api',
    )
    expect(text({ ...allowed, sandbox: OUTSIDE })).toBe('Allowed once: run outside the sandbox')
    expect(text({ state: PermissionRequestState.Denied, sandbox: NPM, denyNote: 'No installs.' })).toBe(
      'Denied: reach registry.npmjs.org · “No installs.”',
    )
    expect(text({ state: PermissionRequestState.Denied, sandbox: NPM })).toBe('Denied: reach registry.npmjs.org')
    expect(text({ state: PermissionRequestState.Withdrawn, sandbox: API })).toBe(
      'Withdrawn: write to ~/code/acme-web/src/api',
    )
  })

  it('names a single file as it names a folder, and another user’s folder in full', () => {
    const file: SandboxAsk = {
      kind: SandboxAskKind.Folder,
      path: '/Users/me/.gitconfig',
      access: FolderAccess.Read,
      file: true,
    }
    expect(text({ sandbox: file })).toBe('Waiting on you: read ~/.gitconfig')
    expect(text({ ...allowed, sandbox: file, grantedScope: SandboxGrantScope.Workspace })).toBe(
      'Allowed for this workspace: read ~/.gitconfig',
    )
    const theirs: SandboxAsk = {
      kind: SandboxAskKind.Folder,
      path: '/Users/someone/Documents',
      access: FolderAccess.Read,
    }
    expect(text({ sandbox: theirs })).toBe('Waiting on you: read /Users/someone/Documents')
  })

  // #515: an MCP server Glade doesn't build, and the tools that reach other agents.
  it('names the MCP server by the name it was reported under, and the other agents by what reaching them does', () => {
    const docs: SandboxAsk = {
      kind: SandboxAskKind.McpServer,
      server: 'claude_ai_Acme_Docs',
      name: 'claude.ai Acme Docs',
    }
    const sessions: SandboxAsk = { kind: SandboxAskKind.Agents, agents: OtherAgents.Sessions }
    const cloud: SandboxAsk = { kind: SandboxAskKind.Agents, agents: OtherAgents.Cloud }

    expect(text({ sandbox: docs })).toBe('Waiting on you: use the claude.ai Acme Docs MCP server')
    expect(text({ ...allowed, sandbox: docs, grantedScope: SandboxGrantScope.Workspace })).toBe(
      'Allowed for this workspace: use the claude.ai Acme Docs MCP server',
    )
    expect(text({ ...allowed, sandbox: sessions, grantedScope: SandboxGrantScope.Task })).toBe(
      'Allowed for this task: message other Claude sessions',
    )
    expect(text({ state: PermissionRequestState.Denied, sandbox: cloud, denyNote: 'Not from here.' })).toBe(
      'Denied: manage cloud agents · “Not from here.”',
    )
    expect(text({ state: PermissionRequestState.Denied, sandbox: docs })).toBe(
      'Denied: use the claude.ai Acme Docs MCP server',
    )
    expect(text({ state: PermissionRequestState.Withdrawn, sandbox: sessions })).toBe(
      'Withdrawn: message other Claude sessions',
    )
  })

  it('is teal for a grant to the task or the workspace, as for a rule', () => {
    const granted = requestPermissionLine(
      request('p1', { ...allowed, sandbox: WEB, grantedScope: SandboxGrantScope.Task }),
    )
    expect(granted).toEqual({
      state: PermissionLineState.Allowed,
      scope: PermissionLineScope.Task,
      subject: 'read ~/code/acme-web',
    })
  })
})

describe('the line of a call a rule decided', () => {
  const SHARED = { kind: SandboxAskKind.Folder, path: '/Users/me/code/acme-shared', access: FolderAccess.Read } as const
  const UV = { kind: SandboxAskKind.Folder, path: '/Users/me/.cache/uv', access: FolderAccess.ReadWrite } as const
  const mark = (toolUseId: string, outcome: PermissionMarkOutcome): PermissionMark => ({
    taskId: 't1',
    toolUseId,
    outcome,
    createdAt: 1,
  })
  const text = (outcome: PermissionMarkOutcome): string => permissionLineText(markPermissionLine({ outcome }))
  const grant = (scope: SandboxGrantScope): PermissionMarkOutcome => ({
    kind: PermissionMarkKind.Grant,
    scope,
    ask: SHARED,
  })

  it('says whose grant let it through, and what for', () => {
    expect(text(grant(SandboxGrantScope.Workspace))).toBe('Allowed by workspace grant: read ~/code/acme-shared')
    expect(text(grant(SandboxGrantScope.Glade))).toBe('Allowed by Glade-wide grant: read ~/code/acme-shared')
    expect(text(grant(SandboxGrantScope.Task))).toBe('Allowed by task grant: read ~/code/acme-shared')
    const docs = {
      kind: SandboxAskKind.Domain,
      domain: 'docs.acme.dev',
      command: null,
      commandDescription: null,
    } as const
    expect(text({ kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: docs })).toBe(
      'Allowed by workspace grant: reach docs.acme.dev',
    )
  })

  it('says whose grant let a call to an MCP server, or to other agents, through', () => {
    const gmail = { kind: SandboxAskKind.McpServer, server: 'gmail', name: 'Gmail' } as const
    const sessions = { kind: SandboxAskKind.Agents, agents: OtherAgents.Sessions } as const
    const cloud = { kind: SandboxAskKind.Agents, agents: OtherAgents.Cloud } as const

    expect(text({ kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Workspace, ask: gmail })).toBe(
      'Allowed by workspace grant: use the Gmail MCP server',
    )
    expect(text({ kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Task, ask: sessions })).toBe(
      'Allowed by task grant: message other Claude sessions',
    )
    expect(text({ kind: PermissionMarkKind.Grant, scope: SandboxGrantScope.Glade, ask: cloud })).toBe(
      'Allowed by Glade-wide grant: manage cloud agents',
    )
  })

  it('names the task rule that let it through, as the card that made it did', () => {
    const lint = { toolName: 'Bash', ruleContent: 'npm run lint *' }
    expect(text({ kind: PermissionMarkKind.TaskRule, rule: lint })).toBe('Allowed by task rule: npm run lint commands')
    expect(text({ kind: PermissionMarkKind.TaskRule, rule: { toolName: 'Edit' } })).toBe('Allowed by task rule: Edit')
  })

  it('says the sandbox blocked it, and what of once that’s known', () => {
    expect(markPermissionLine({ outcome: { kind: PermissionMarkKind.Blocked, ask: null } })).toEqual({
      state: PermissionLineState.Blocked,
      subject: null,
    })
    expect(text({ kind: PermissionMarkKind.Blocked, ask: null })).toBe('Blocked by the sandbox')
    expect(text({ kind: PermissionMarkKind.Blocked, ask: UV })).toBe('Blocked by the sandbox: write to ~/.cache/uv')
  })

  it('gives each marked call its line, and a call you were asked about your answer over a rule’s', () => {
    const marks = [
      mark('use-read', grant(SandboxGrantScope.Workspace)),
      mark('use-blocked', { kind: PermissionMarkKind.Blocked, ask: UV }),
      // A call the rule seemed to cover, that asked anyway.
      mark('toolu-p1', { kind: PermissionMarkKind.TaskRule, rule: { toolName: 'Bash', ruleContent: 'npm test *' } }),
    ]
    const lines = permissionLinesByToolUse([closed('p1', PermissionRequestState.Denied)], marks)

    expect([...lines].map(([toolUseId, line]) => [toolUseId, permissionLineText(line)])).toEqual([
      ['use-read', 'Allowed by workspace grant: read ~/code/acme-shared'],
      ['use-blocked', 'Blocked by the sandbox: write to ~/.cache/uv'],
      ['toolu-p1', 'Denied'],
    ])
    expect(permissionLinesByToolUse([], marks).size).toBe(3)
    expect(permissionLinesByToolUse([], [])).toBe(NO_PERMISSION_LINES)
  })
})
