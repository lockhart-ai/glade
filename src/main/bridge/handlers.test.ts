import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CommandName, EventType, type GladeEvent } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { createHandlers, type Handlers } from './handlers'

let database: TestDatabase
let root: string
let emit: Mock<(event: GladeEvent) => void>
let chooseFolder: Mock<() => Promise<string | null>>
let handlers: Handlers

beforeEach(() => {
  database = openTestDatabase()
  root = mkdtempSync(join(tmpdir(), 'glade-handlers-'))
  emit = vi.fn()
  chooseFolder = vi.fn(() => Promise.resolve(root))
  handlers = createHandlers({ db: database.db, emit, chooseFolder })
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('workspaces.create', () => {
  it('broadcasts a workspace it adds', async () => {
    const { workspace, created } = await handlers[CommandName.WorkspacesCreate]({ rootPath: root })

    expect(created).toBe(true)
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.WorkspaceUpdated, workspace })
  })

  it('broadcasts nothing when answering with an existing workspace', async () => {
    const first = await handlers[CommandName.WorkspacesCreate]({ rootPath: root })
    emit.mockClear()

    expect(await handlers[CommandName.WorkspacesCreate]({ rootPath: root })).toEqual({ ...first, created: false })
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('workspaces.open', () => {
  it('broadcasts the opened workspace and each UI state value it changed', async () => {
    const other = sampleWorkspace(database.db, '/code/acme-web')
    const workspace = sampleWorkspace(database.db)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: sampleTask(database.db, other.id).id })

    const opened = await handlers[CommandName.WorkspacesOpen]({ id: workspace.id })

    expect(opened.workspace.lastOpenedAt).toBeGreaterThanOrEqual(workspace.lastOpenedAt)
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: EventType.WorkspaceUpdated, workspace: opened.workspace },
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.ActiveWorkspaceId, value: workspace.id } },
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.SelectedTaskId, value: '' } },
    ])
  })
})

describe('dialog.chooseFolder', () => {
  it('answers with the chosen folder, or null when cancelled', async () => {
    await expect(handlers[CommandName.DialogChooseFolder]({})).resolves.toEqual({ path: root })
    chooseFolder.mockResolvedValueOnce(null)
    await expect(handlers[CommandName.DialogChooseFolder]({})).resolves.toEqual({ path: null })
  })
})
