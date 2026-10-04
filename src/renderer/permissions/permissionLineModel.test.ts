import { describe, expect, it } from 'vitest'
import {
  NO_PERMISSION_LINES,
  PermissionLineScope,
  PermissionLineState,
  permissionDetail,
  permissionLineText,
  permissionStatus,
  ranWithPermission,
  samePermissionLine,
  type PermissionLine,
} from './permissionLineModel'

function allowed(scope: PermissionLineScope, subject: string | null = null): PermissionLine {
  return { state: PermissionLineState.Allowed, scope, subject }
}

function denied(subject: string | null, note: string | null): PermissionLine {
  return { state: PermissionLineState.Denied, subject, note }
}

const WAITING: PermissionLine = { state: PermissionLineState.Waiting, subject: null }
const WITHDRAWN: PermissionLine = { state: PermissionLineState.Withdrawn, subject: null }
const BLOCKED: PermissionLine = { state: PermissionLineState.Blocked, subject: 'write to ~/.cache/uv' }

describe('the status', () => {
  it('says who granted it, and how far: you on a card, or a rule', () => {
    expect(Object.values(PermissionLineScope).map((scope) => [scope, permissionStatus(allowed(scope))])).toEqual([
      [PermissionLineScope.Once, 'Allowed once'],
      [PermissionLineScope.Task, 'Allowed for this task'],
      [PermissionLineScope.Workspace, 'Allowed for this workspace'],
      [PermissionLineScope.TaskRule, 'Allowed by task rule'],
      [PermissionLineScope.TaskGrant, 'Allowed by task grant'],
      [PermissionLineScope.WorkspaceGrant, 'Allowed by workspace grant'],
      [PermissionLineScope.GladeGrant, 'Allowed by Glade-wide grant'],
    ])
  })

  it('says a request waits, was denied, was blocked by the sandbox, or was withdrawn', () => {
    expect(permissionStatus(WAITING)).toBe('Waiting on you')
    expect(permissionStatus(denied(null, null))).toBe('Denied')
    expect(permissionStatus(BLOCKED)).toBe('Blocked by the sandbox')
    expect(permissionStatus(WITHDRAWN)).toBe('Withdrawn')
  })
})

describe('the line', () => {
  it('is its status alone, with no colon, when there is nothing to name', () => {
    expect(permissionDetail(WAITING)).toBeNull()
    expect(permissionLineText(WAITING)).toBe('Waiting on you')
    expect(permissionLineText(allowed(PermissionLineScope.Once))).toBe('Allowed once')
    expect(permissionLineText(WITHDRAWN)).toBe('Withdrawn')
    expect(permissionLineText(denied(null, null))).toBe('Denied')
  })

  it('puts what it was about after the status and a colon', () => {
    expect(permissionLineText(allowed(PermissionLineScope.Task, 'npm run lint commands'))).toBe(
      'Allowed for this task: npm run lint commands',
    )
    expect(permissionLineText(allowed(PermissionLineScope.Workspace, 'write to ~/code/acme-web/src/api'))).toBe(
      'Allowed for this workspace: write to ~/code/acme-web/src/api',
    )
    expect(permissionLineText(allowed(PermissionLineScope.WorkspaceGrant, 'read ~/code/acme-shared'))).toBe(
      'Allowed by workspace grant: read ~/code/acme-shared',
    )
    expect(permissionLineText(BLOCKED)).toBe('Blocked by the sandbox: write to ~/.cache/uv')
    expect(permissionLineText({ ...WAITING, subject: 'reach registry.npmjs.org' })).toBe(
      'Waiting on you: reach registry.npmjs.org',
    )
    expect(permissionLineText({ ...WITHDRAWN, subject: 'write to ~/.cache/uv' })).toBe(
      'Withdrawn: write to ~/.cache/uv',
    )
  })

  it("puts a denial's note last, in quotes, after a middle dot when there's a subject too", () => {
    expect(permissionLineText(denied(null, 'Keep dist, the smoke test reads it.'))).toBe(
      'Denied: “Keep dist, the smoke test reads it.”',
    )
    expect(permissionLineText(denied('reach registry.npmjs.org', 'No installs.'))).toBe(
      'Denied: reach registry.npmjs.org · “No installs.”',
    )
    expect(permissionLineText(denied('reach registry.npmjs.org', null))).toBe('Denied: reach registry.npmjs.org')
  })

  it('takes a blank subject or note for none, and trims them', () => {
    expect(permissionLineText(denied('  ', ' \n '))).toBe('Denied')
    expect(permissionLineText(denied(' reach a.test ', '  Not now  '))).toBe('Denied: reach a.test · “Not now”')
    expect(permissionLineText(allowed(PermissionLineScope.Task, ''))).toBe('Allowed for this task')
  })
})

describe('telling two lines apart', () => {
  it('takes lines that read the same in the same state for the same, however they were made', () => {
    expect(samePermissionLine(null, null)).toBe(true)
    expect(samePermissionLine(WAITING, WAITING)).toBe(true)
    expect(samePermissionLine(WAITING, { ...WAITING })).toBe(true)
    expect(samePermissionLine(denied(null, 'No'), denied(null, 'No'))).toBe(true)
    expect(
      samePermissionLine(allowed(PermissionLineScope.Task, 'Edit'), allowed(PermissionLineScope.Task, 'Edit')),
    ).toBe(true)
  })

  it('tells apart a line from none, and lines whose state, scope, subject or note differ', () => {
    expect(samePermissionLine(WAITING, null)).toBe(false)
    expect(samePermissionLine(null, WAITING)).toBe(false)
    expect(samePermissionLine(WAITING, WITHDRAWN)).toBe(false)
    expect(samePermissionLine(allowed(PermissionLineScope.Once), allowed(PermissionLineScope.Task))).toBe(false)
    expect(
      samePermissionLine(allowed(PermissionLineScope.Task, 'Edit'), allowed(PermissionLineScope.Task, 'Write')),
    ).toBe(false)
    expect(samePermissionLine(denied(null, 'No'), denied(null, 'Not yet'))).toBe(false)
    expect(samePermissionLine(denied(null, null), denied(null, 'No'))).toBe(false)
  })

  it('tells a denial from a blocked call that would read alike', () => {
    const deniedLine: PermissionLine = { state: PermissionLineState.Denied, subject: 'x', note: null }
    const withdrawnLine: PermissionLine = { state: PermissionLineState.Withdrawn, subject: 'x' }
    expect(samePermissionLine(deniedLine, withdrawnLine)).toBe(false)
  })
})

describe('whether the call ran', () => {
  it('did when it was granted, or the sandbox blocked something of it; not while it waits, nor denied or withdrawn', () => {
    expect(ranWithPermission(allowed(PermissionLineScope.Once))).toBe(true)
    expect(ranWithPermission(allowed(PermissionLineScope.GladeGrant, 'read ~/.nvm'))).toBe(true)
    expect(ranWithPermission(BLOCKED)).toBe(true)
    expect(ranWithPermission(WAITING)).toBe(false)
    expect(ranWithPermission(denied(null, null))).toBe(false)
    expect(ranWithPermission(WITHDRAWN)).toBe(false)
  })
})

it('has no lines for a task with no requests', () => {
  expect(NO_PERMISSION_LINES.size).toBe(0)
})
