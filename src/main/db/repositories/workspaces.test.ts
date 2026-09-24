import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from './test-database'
import { createWorkspace, getWorkspace, getWorkspaceByRoot, listWorkspaces, updateWorkspace } from './workspaces'

let test: TestDatabase

beforeEach(() => {
  test = openTestDatabase()
})

afterEach(() => {
  test.close()
})

describe('createWorkspace', () => {
  it('stores a workspace with a new UUID, opened as it is created', () => {
    const workspace = createWorkspace(test.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)

    expect(workspace).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      name: 'Acme API',
      rootPath: '/code/acme-api',
      createdAt: 1_000,
      lastOpenedAt: 1_000,
    })
    expect(getWorkspace(test.db, workspace.id)).toEqual(workspace)
  })

  it('defaults the time to now', () => {
    const before = Date.now()
    const workspace = createWorkspace(test.db, { name: 'Acme API', rootPath: '/code/acme-api' })
    expect(workspace.createdAt).toBeGreaterThanOrEqual(before)
    expect(workspace.createdAt).toBeLessThanOrEqual(Date.now())
  })

  it('refuses a second workspace on the same root', () => {
    sampleWorkspace(test.db, '/code/acme-api')
    expect(() => sampleWorkspace(test.db, '/code/acme-api')).toThrow('UNIQUE constraint failed')
  })
})

describe('getWorkspace', () => {
  it('is undefined for an unknown id', () => {
    expect(getWorkspace(test.db, 'missing')).toBeUndefined()
  })
})

describe('getWorkspaceByRoot', () => {
  it('finds the workspace with that root, or none', () => {
    const workspace = sampleWorkspace(test.db, '/code/acme-api')

    expect(getWorkspaceByRoot(test.db, '/code/acme-api')).toEqual(workspace)
    expect(getWorkspaceByRoot(test.db, '/code/acme-web')).toBeUndefined()
  })
})

describe('listWorkspaces', () => {
  it('lists workspaces oldest first', () => {
    const second = createWorkspace(test.db, { name: 'Billing', rootPath: '/code/billing' }, 2_000)
    const first = createWorkspace(test.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)

    expect(listWorkspaces(test.db)).toEqual([first, second])
  })

  it('is empty for a fresh database', () => {
    expect(listWorkspaces(test.db)).toEqual([])
  })
})

describe('updateWorkspace', () => {
  it('changes the given fields and keeps the rest', () => {
    const workspace = sampleWorkspace(test.db)

    const renamed = updateWorkspace(test.db, workspace.id, { name: 'Acme' })
    expect(renamed).toEqual({ ...workspace, name: 'Acme' })

    const moved = updateWorkspace(test.db, workspace.id, { rootPath: '/code/acme', lastOpenedAt: 5_000 })
    expect(moved).toEqual({ ...workspace, name: 'Acme', rootPath: '/code/acme', lastOpenedAt: 5_000 })
    expect(getWorkspace(test.db, workspace.id)).toEqual(moved)
  })

  it('throws for an unknown id', () => {
    expect(() => updateWorkspace(test.db, 'missing', { name: 'Acme' })).toThrow('No workspace missing')
  })
})
