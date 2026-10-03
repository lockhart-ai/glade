import { describe, expect, it } from 'vitest'
import {
  coversAccess,
  FolderAccess,
  grantCovers,
  mergeGrants,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
} from './sandbox'

const read = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.Read })
const readWrite = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.ReadWrite })
const domain = (host: string): Grant => ({ kind: SandboxGrantKind.Domain, domain: host })

describe('coversAccess', () => {
  it('ranks read-write over read-only', () => {
    expect(coversAccess(FolderAccess.ReadWrite, FolderAccess.Read)).toBe(true)
    expect(coversAccess(FolderAccess.ReadWrite, FolderAccess.ReadWrite)).toBe(true)
    expect(coversAccess(FolderAccess.Read, FolderAccess.Read)).toBe(true)
    expect(coversAccess(FolderAccess.Read, FolderAccess.ReadWrite)).toBe(false)
  })
})

describe('mergeGrants', () => {
  it('is empty for no grants', () => {
    expect(mergeGrants([])).toEqual([])
  })

  it('keeps each folder once, with the widest access, wherever it comes in the list', () => {
    expect(mergeGrants([read('/opt/sdk'), readWrite('/opt/sdk'), read('/opt/sdk')])).toEqual([readWrite('/opt/sdk')])
    expect(mergeGrants([readWrite('/opt/sdk'), read('/opt/sdk')])).toEqual([readWrite('/opt/sdk')])
    expect(mergeGrants([read('/opt/sdk'), read('/opt/sdk')])).toEqual([read('/opt/sdk')])
  })

  it('keeps each domain once, and a domain and a folder with the same value apart', () => {
    expect(mergeGrants([domain('acme.dev'), read('acme.dev'), domain('acme.dev')])).toEqual([
      domain('acme.dev'),
      read('acme.dev'),
    ])
  })

  it('keeps the order each was first granted, a widened folder in its first place', () => {
    expect(
      mergeGrants([
        read('/opt/a'),
        domain('registry.npmjs.org'),
        read('/opt/b'),
        readWrite('/opt/a'),
        domain('acme.dev'),
      ]),
    ).toEqual([readWrite('/opt/a'), domain('registry.npmjs.org'), read('/opt/b'), domain('acme.dev')])
  })

  it('keeps nested folders apart: each is its own grant', () => {
    expect(mergeGrants([read('/Users/sam/code'), readWrite('/Users/sam/code/acme')])).toEqual([
      read('/Users/sam/code'),
      readWrite('/Users/sam/code/acme'),
    ])
  })
})

describe('grantCovers', () => {
  const task = { id: 't1', workspaceId: 'w1' }

  it('covers every task Glade-wide, a workspace’s tasks, and one task', () => {
    expect(grantCovers({ scope: SandboxGrantScope.Glade }, task)).toBe(true)
    expect(grantCovers({ scope: SandboxGrantScope.Workspace, workspaceId: 'w1' }, task)).toBe(true)
    expect(grantCovers({ scope: SandboxGrantScope.Workspace, workspaceId: 'w2' }, task)).toBe(false)
    expect(grantCovers({ scope: SandboxGrantScope.Task, taskId: 't1' }, task)).toBe(true)
    expect(grantCovers({ scope: SandboxGrantScope.Task, taskId: 't2' }, task)).toBe(false)
  })

  it('never takes a task id for a workspace id', () => {
    expect(grantCovers({ scope: SandboxGrantScope.Task, taskId: 'w1' }, task)).toBe(false)
    expect(grantCovers({ scope: SandboxGrantScope.Workspace, workspaceId: 't1' }, task)).toBe(false)
  })
})
