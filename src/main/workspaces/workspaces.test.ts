import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { CommandError } from '../bridge/errors'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { getUiState, listUiState, setUiState } from '../db/repositories/ui-state'
import { getWorkspace, listWorkspaces } from '../db/repositories/workspaces'
import { STARTER_CLAUDE_MD } from './starter-claude-md'
import { createWorkspaceAt, openWorkspace } from './workspaces'

let database: TestDatabase
let dir: string

beforeEach(() => {
  database = openTestDatabase()
  dir = mkdtempSync(join(tmpdir(), 'glade-workspaces-'))
})

afterEach(() => {
  database.close()
  rmSync(dir, { recursive: true, force: true })
})

function folder(name: string): string {
  const path = join(dir, name)
  mkdirSync(path)
  return path
}

describe('createWorkspaceAt', () => {
  it('stores a workspace named after its folder and seeds the starter CLAUDE.md', () => {
    const root = folder('acme-api')

    const { workspace, created } = createWorkspaceAt(database.db, root, 1_000)

    expect(created).toBe(true)
    expect(workspace).toMatchObject({ name: 'acme-api', rootPath: root, createdAt: 1_000, lastOpenedAt: 1_000 })
    expect(getWorkspace(database.db, workspace.id)).toEqual(workspace)
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(STARTER_CLAUDE_MD)
  })

  it('keeps an existing CLAUDE.md', () => {
    const root = folder('acme-api')
    writeFileSync(join(root, 'CLAUDE.md'), '# Mine\n')

    createWorkspaceAt(database.db, root)

    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Mine\n')
  })

  it('answers with the existing workspace for a root it already has, however the path is written', () => {
    const root = folder('acme-api')
    const first = createWorkspaceAt(database.db, root, 1_000).workspace
    rmSync(join(root, 'CLAUDE.md'))

    expect(createWorkspaceAt(database.db, `${root}/`, 2_000)).toEqual({ workspace: first, created: false })
    expect(createWorkspaceAt(database.db, join(root, '..', 'acme-api'), 2_000)).toEqual({
      workspace: first,
      created: false,
    })
    expect(listWorkspaces(database.db)).toEqual([first])
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false)
  })

  it.each([
    ['a missing folder', (): string => join(dir, 'missing')],
    [
      'a file',
      (): string => {
        writeFileSync(join(dir, 'notes.txt'), '')
        return join(dir, 'notes.txt')
      },
    ],
  ])('refuses %s as the root, storing and writing nothing', (_case, root) => {
    const path = root()

    expect(() => createWorkspaceAt(database.db, path)).toThrow(
      new CommandError(BridgeErrorCode.InvalidRootPath, `${path} is not a folder`),
    )
    expect(listWorkspaces(database.db)).toEqual([])
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false)
  })
})

describe('openWorkspace', () => {
  it('records the workspace as last opened and makes it the active workspace', () => {
    const workspace = sampleWorkspace(database.db)

    const opening = openWorkspace(database.db, workspace.id, 9_000)

    expect(opening).toEqual({
      workspace: { ...workspace, lastOpenedAt: 9_000 },
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: workspace.id }],
    })
    expect(getWorkspace(database.db, workspace.id)?.lastOpenedAt).toBe(9_000)
    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe(workspace.id)
  })

  it("deselects the selected task when it's in another workspace", () => {
    const other = sampleWorkspace(database.db, '/code/acme-web')
    const workspace = sampleWorkspace(database.db)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: sampleTask(database.db, other.id).id })

    const { uiState } = openWorkspace(database.db, workspace.id)

    expect(uiState).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: workspace.id },
      { key: UiStateKey.SelectedTaskId, value: '' },
    ])
    expect(getUiState(database.db, UiStateKey.SelectedTaskId)).toBe('')
  })

  it('keeps a selected task in the same workspace, or one that is gone', () => {
    const workspace = sampleWorkspace(database.db)
    const task = sampleTask(database.db, workspace.id)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })

    expect(openWorkspace(database.db, workspace.id).uiState).toHaveLength(1)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: 'gone' })
    expect(openWorkspace(database.db, workspace.id).uiState).toHaveLength(1)
  })

  it('refuses an unknown workspace, changing nothing', () => {
    expect(() => openWorkspace(database.db, 'gone')).toThrow(
      new CommandError(BridgeErrorCode.NotFound, 'No workspace gone'),
    )
    expect(listUiState(database.db)).toEqual([])
  })
})
