import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { describeIssues, REQUEST_SCHEMAS } from './requests'

const KEY = UiStateKey.ActiveWorkspaceId
const BAD_KEY = 'key: Invalid option: expected one of "active_workspace_id"|"selected_task_id"'

describe('REQUEST_SCHEMAS', () => {
  it('parses valid requests', () => {
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesList].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesCreate].parse({ rootPath: '/code/acme-api' })).toEqual({
      rootPath: '/code/acme-api',
    })
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesOpen].parse({ id: 'w' })).toEqual({ id: 'w' })
    expect(REQUEST_SCHEMAS[CommandName.DialogChooseFolder].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.TasksList].parse({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' })
    expect(REQUEST_SCHEMAS[CommandName.UiStateGet].parse({ key: KEY })).toEqual({ key: KEY })
    expect(REQUEST_SCHEMAS[CommandName.UiStateGetAll].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.UiStateSet].parse({ key: KEY, value: '' })).toEqual({ key: KEY, value: '' })
  })

  it.each([
    ['a missing request', CommandName.WorkspacesList, undefined, 'Invalid input: expected object, received undefined'],
    ['null', CommandName.UiStateGet, null, 'Invalid input: expected object, received null'],
    ['an array', CommandName.UiStateGet, [KEY], 'Invalid input: expected object, received array'],
    ['an unexpected field', CommandName.WorkspacesList, { all: true }, 'Unrecognized key: "all"'],
    ['unexpected fields', CommandName.UiStateGet, { key: KEY, a: 1, b: 2 }, 'Unrecognized keys: "a", "b"'],
    ['a missing key', CommandName.UiStateGet, {}, BAD_KEY],
    [
      'a missing workspace id',
      CommandName.TasksList,
      {},
      'workspaceId: Invalid input: expected string, received undefined',
    ],
    [
      'a relative root path',
      CommandName.WorkspacesCreate,
      { rootPath: 'code/acme-api' },
      'rootPath: Expected an absolute path',
    ],
    ['an empty root path', CommandName.WorkspacesCreate, { rootPath: '' }, 'rootPath: Expected an absolute path'],
    [
      'a missing root path',
      CommandName.WorkspacesCreate,
      {},
      'rootPath: Invalid input: expected string, received undefined',
    ],
    ['a workspace name', CommandName.WorkspacesCreate, { rootPath: '/code', name: 'x' }, 'Unrecognized key: "name"'],
    [
      'a missing workspace id',
      CommandName.WorkspacesOpen,
      {},
      'id: Invalid input: expected string, received undefined',
    ],
    ['arguments to dialog.chooseFolder', CommandName.DialogChooseFolder, { title: 'x' }, 'Unrecognized key: "title"'],
    ['arguments to uiState.getAll', CommandName.UiStateGetAll, { key: KEY }, 'Unrecognized key: "key"'],
    ['an unknown key', CommandName.UiStateSet, { key: 'theme', value: 'dark' }, BAD_KEY],
    [
      'a missing key and value',
      CommandName.UiStateSet,
      {},
      `${BAD_KEY}; value: Invalid input: expected string, received undefined`,
    ],
    [
      'a non-string value',
      CommandName.UiStateSet,
      { key: KEY, value: 3 },
      'value: Invalid input: expected string, received number',
    ],
  ])('rejects %s, saying why in short', (_case, command, raw, message) => {
    const parsed = REQUEST_SCHEMAS[command].safeParse(raw)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(describeIssues(parsed.error)).toBe(message)
  })
})
