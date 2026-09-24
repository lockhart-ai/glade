import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import { MessageRole, UiStateKey } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendMessage, listMessages } from '../db/repositories/messages'
import { listTasks } from '../db/repositories/tasks'
import { getUiState, listUiState, setUiState } from '../db/repositories/ui-state'
import { getWorkspaceSelection } from '../db/repositories/workspace-selections'
import { getWorkspace, listWorkspaces } from '../db/repositories/workspaces'
import { STARTER_CLAUDE_MD } from './starter-claude-md'
import { changeWorkspace, createWorkspaceAt, noteSelection, openWorkspace, removeWorkspace } from './workspaces'

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
      new CommandFailure(BridgeErrorCode.InvalidRootPath, `${path} is not a folder`),
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
      selectedTaskId: null,
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: workspace.id }],
    })
    expect(getWorkspace(database.db, workspace.id)?.lastOpenedAt).toBe(9_000)
    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe(workspace.id)
  })

  it("deselects the selected task when it's in another workspace and this one has no selection", () => {
    const other = sampleWorkspace(database.db, '/code/acme-web')
    const workspace = sampleWorkspace(database.db)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: sampleTask(database.db, other.id).id })

    const { uiState, selectedTaskId } = openWorkspace(database.db, workspace.id)

    expect(selectedTaskId).toBeNull()
    expect(uiState).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: workspace.id },
      { key: UiStateKey.SelectedTaskId, value: '' },
    ])
    expect(getUiState(database.db, UiStateKey.SelectedTaskId)).toBe('')
  })

  it('selects the task last selected in the workspace', () => {
    const acme = sampleWorkspace(database.db)
    const web = sampleWorkspace(database.db, '/code/acme-web')
    const inAcme = sampleTask(database.db, acme.id)
    const inWeb = sampleTask(database.db, web.id)
    select(acme.id, inAcme.id)
    select(web.id, inWeb.id)

    const { uiState, selectedTaskId } = openWorkspace(database.db, acme.id)

    expect(selectedTaskId).toBe(inAcme.id)
    expect(uiState).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: acme.id },
      { key: UiStateKey.SelectedTaskId, value: inAcme.id },
    ])
    expect(openWorkspace(database.db, web.id).selectedTaskId).toBe(inWeb.id)
    expect(getUiState(database.db, UiStateKey.SelectedTaskId)).toBe(inWeb.id)
  })

  it('keeps a selected task in the same workspace', () => {
    const workspace = sampleWorkspace(database.db)
    const task = sampleTask(database.db, workspace.id)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })

    expect(openWorkspace(database.db, workspace.id)).toMatchObject({
      selectedTaskId: task.id,
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: workspace.id }],
    })
  })

  it('drops a selected task that is gone', () => {
    const workspace = sampleWorkspace(database.db)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: 'gone' })

    expect(openWorkspace(database.db, workspace.id).uiState).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: workspace.id },
      { key: UiStateKey.SelectedTaskId, value: '' },
    ])
  })

  it('refuses an unknown workspace, changing nothing', () => {
    expect(() => openWorkspace(database.db, 'gone')).toThrow(
      new CommandFailure(BridgeErrorCode.NotFound, 'No workspace gone'),
    )
    expect(listUiState(database.db)).toEqual([])
  })
})

describe('changeWorkspace', () => {
  it('renames a workspace, trimmed, and moves it to another root, resolved, writing nothing to either folder', () => {
    const old = folder('acme-api')
    const workspace = createWorkspaceAt(database.db, old, 1_000).workspace
    const next = folder('acme')

    expect(changeWorkspace(database.db, workspace.id, { name: '  Acme  ' })).toEqual({ ...workspace, name: 'Acme' })
    const moved = changeWorkspace(database.db, workspace.id, { rootPath: `${next}/` })

    expect(moved).toEqual({ ...workspace, name: 'Acme', rootPath: next })
    expect(getWorkspace(database.db, workspace.id)).toEqual(moved)
    expect(existsSync(join(next, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(old, 'CLAUDE.md'))).toBe(true)
  })

  it('keeps its own root, and changes nothing for an empty patch', () => {
    const root = folder('acme-api')
    const workspace = createWorkspaceAt(database.db, root).workspace

    expect(changeWorkspace(database.db, workspace.id, { rootPath: root })).toEqual(workspace)
    expect(changeWorkspace(database.db, workspace.id, {})).toEqual(workspace)
  })

  it('refuses an unknown workspace, a blank name, a root that is not a folder, and another workspace’s root', () => {
    const workspace = createWorkspaceAt(database.db, folder('acme-api')).workspace
    const other = createWorkspaceAt(database.db, folder('acme-web')).workspace

    expect(() => changeWorkspace(database.db, 'gone', { name: 'x' })).toThrow(
      new CommandFailure(BridgeErrorCode.NotFound, 'No workspace gone'),
    )
    expect(() => changeWorkspace(database.db, workspace.id, { name: ' ' })).toThrow(
      new CommandFailure(BridgeErrorCode.InvalidRequest, 'A workspace name cannot be blank'),
    )
    const missing = join(dir, 'missing')
    expect(() => changeWorkspace(database.db, workspace.id, { rootPath: missing })).toThrow(
      new CommandFailure(BridgeErrorCode.InvalidRootPath, `${missing} is not a folder`),
    )
    expect(() => changeWorkspace(database.db, workspace.id, { rootPath: other.rootPath })).toThrow(
      new CommandFailure(BridgeErrorCode.InvalidRootPath, `${other.rootPath} is already the workspace acme-web`),
    )
    expect(getWorkspace(database.db, workspace.id)).toEqual(workspace)
  })
})
describe('noteSelection', () => {
  it("records a selected task as its workspace's selection", () => {
    const acme = sampleWorkspace(database.db)
    const task = sampleTask(database.db, acme.id)

    noteSelection(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })

    expect(getWorkspaceSelection(database.db, acme.id)).toBe(task.id)
  })

  it("clears the shown workspace's selection when no task is selected", () => {
    const acme = sampleWorkspace(database.db)
    const web = sampleWorkspace(database.db, '/code/acme-web')
    const inAcme = sampleTask(database.db, acme.id)
    select(acme.id, inAcme.id)
    select(web.id, sampleTask(database.db, web.id).id)

    noteSelection(database.db, { key: UiStateKey.SelectedTaskId, value: '' })

    expect(getWorkspaceSelection(database.db, web.id)).toBeUndefined()
    expect(getWorkspaceSelection(database.db, acme.id)).toBe(inAcme.id)
  })

  it('ignores other keys, a missing task, and no selection with no workspace shown', () => {
    const acme = sampleWorkspace(database.db)

    noteSelection(database.db, { key: UiStateKey.TaskFilter, value: 'unread' })
    noteSelection(database.db, { key: UiStateKey.SelectedTaskId, value: 'gone' })
    noteSelection(database.db, { key: UiStateKey.SelectedTaskId, value: '' })

    expect(getWorkspaceSelection(database.db, acme.id)).toBeUndefined()
  })
})

/** Shows a workspace and selects a task in it, as the window does. */
function select(workspaceId: string, taskId: string): void {
  setUiState(database.db, { key: UiStateKey.ActiveWorkspaceId, value: workspaceId })
  const entry = { key: UiStateKey.SelectedTaskId, value: taskId }
  noteSelection(database.db, entry)
  setUiState(database.db, entry)
}

describe('removeWorkspace', () => {
  function removal() {
    return { db: database.db, emit: vi.fn(), runner: { discard: vi.fn() } }
  }

  it("closes its tasks' sessions and deletes it and everything of its tasks, leaving the others and the folder", () => {
    const root = folder('acme-api')
    const acme = createWorkspaceAt(database.db, root).workspace
    const web = sampleWorkspace(database.db, '/code/acme-web')
    const [first, second, kept] = [
      sampleTask(database.db, acme.id),
      sampleTask(database.db, acme.id),
      sampleTask(database.db, web.id),
    ]
    appendMessage(database.db, { taskId: first.id, role: MessageRole.User, body: 'Add rate limiting', turn: 1 })
    setUiState(database.db, { key: UiStateKey.ActiveWorkspaceId, value: web.id })
    const context = removal()

    removeWorkspace(context, acme.id)

    expect(context.runner.discard.mock.calls).toEqual([[first.id], [second.id]].sort())
    expect(listWorkspaces(database.db)).toEqual([web])
    expect(listTasks(database.db, acme.id)).toEqual([])
    expect(listMessages(database.db, first.id)).toEqual([])
    expect(listTasks(database.db, web.id)).toEqual([kept])
    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe(web.id)
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true)
    expect(context.emit.mock.calls.map(([event]) => event as unknown)).toEqual([
      ...[first.id, second.id].sort().map((taskId) => ({ type: EventType.TaskDeleted, taskId })),
      { type: EventType.WorkspaceRemoved, workspaceId: acme.id },
    ])
  })

  it('leaves the window showing no workspace and no task when it was the one shown', () => {
    const acme = sampleWorkspace(database.db)
    const task = sampleTask(database.db, acme.id)
    select(acme.id, task.id)
    const context = removal()

    removeWorkspace(context, acme.id)

    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe('')
    expect(getUiState(database.db, UiStateKey.SelectedTaskId)).toBe('')
    expect(context.emit.mock.calls.slice(0, 2).map(([event]) => event as unknown)).toEqual([
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.ActiveWorkspaceId, value: '' } },
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.SelectedTaskId, value: '' } },
    ])
  })

  it('refuses an unknown workspace', () => {
    expect(() => {
      removeWorkspace(removal(), 'nope')
    }).toThrow(new CommandFailure(BridgeErrorCode.NotFound, 'No workspace nope'))
  })
})
