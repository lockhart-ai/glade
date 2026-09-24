import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { Effort, UiStateKey } from '../../shared/domain'
import { describeIssues, REQUEST_SCHEMAS } from './requests'

const KEY = UiStateKey.ActiveWorkspaceId
const BAD_KEY =
  'key: Invalid option: expected one of "active_workspace_id"|"selected_task_id"|"pinned_section_collapsed"|"active_section_collapsed"|"done_section_collapsed"|"task_filter"|"relaunch_notice"|"right_panel_tab"|"right_panel_width"|"right_panel_collapsed"|"sidebar_collapsed"|"bottom_bar_collapsed"|"terminal_tab"'

describe('REQUEST_SCHEMAS', () => {
  it('parses valid requests', () => {
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesList].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesCreate].parse({ rootPath: '/code/acme-api' })).toEqual({
      rootPath: '/code/acme-api',
    })
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesOpen].parse({ id: 'w' })).toEqual({ id: 'w' })
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesReveal].parse({ id: 'w' })).toEqual({ id: 'w' })
    expect(REQUEST_SCHEMAS[CommandName.DialogChooseFolder].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.TasksList].parse({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' })
    expect(REQUEST_SCHEMAS[CommandName.TasksCreate].parse({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' })
    expect(REQUEST_SCHEMAS[CommandName.TasksMarkDone].parse({ id: 't' })).toEqual({ id: 't' })
    expect(REQUEST_SCHEMAS[CommandName.TasksReopen].parse({ id: 't' })).toEqual({ id: 't' })
    const patch = { title: 'Rate limits', pinned: true, unread: false, model: 'claude-sample-2', effort: Effort.Max }
    expect(REQUEST_SCHEMAS[CommandName.TasksUpdate].parse({ id: 't', patch })).toEqual({ id: 't', patch })
    expect(REQUEST_SCHEMAS[CommandName.TasksUpdate].parse({ id: 't', patch: {} })).toEqual({ id: 't', patch: {} })
    const send = { id: 't', text: ' Fix the **flaky** test.\n' }
    expect(REQUEST_SCHEMAS[CommandName.TasksSend].parse(send)).toEqual(send)
    expect(REQUEST_SCHEMAS[CommandName.TasksHistory].parse({ id: 't' })).toEqual({ id: 't' })
    const answer = { id: 's', answers: { 0: 'by-type', 1: ['Features', 'Fixes'], 2: '' } }
    expect(REQUEST_SCHEMAS[CommandName.QuestionsAnswer].parse(answer)).toEqual(answer)
    expect(REQUEST_SCHEMAS[CommandName.UiStateGet].parse({ key: KEY })).toEqual({ key: KEY })
    expect(REQUEST_SCHEMAS[CommandName.UiStateGetAll].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.UiStateSet].parse({ key: KEY, value: '' })).toEqual({ key: KEY, value: '' })
    const search = { workspaceId: 'w', text: '"Retry-After' }
    expect(REQUEST_SCHEMAS[CommandName.SearchQuery].parse(search)).toEqual(search)
  })

  it('parses the terminal’s requests', () => {
    expect(REQUEST_SCHEMAS[CommandName.TerminalList].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.TerminalCreate].parse({ workspaceId: null })).toEqual({ workspaceId: null })
    expect(REQUEST_SCHEMAS[CommandName.TerminalCreate].parse({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' })
    const size = { id: 'term', cols: 80, rows: 24 }
    expect(REQUEST_SCHEMAS[CommandName.TerminalAttach].parse(size)).toEqual(size)
    expect(REQUEST_SCHEMAS[CommandName.TerminalResize].parse(size)).toEqual(size)
    const write = { id: 'term', data: 'ls -la\r\x03' }
    expect(REQUEST_SCHEMAS[CommandName.TerminalWrite].parse(write)).toEqual(write)
    const rename = { id: 'term', name: ' server ' }
    expect(REQUEST_SCHEMAS[CommandName.TerminalRename].parse(rename)).toEqual(rename)
    for (const command of [
      CommandName.TerminalDuplicate,
      CommandName.TerminalClear,
      CommandName.TerminalInterrupt,
      CommandName.TerminalClose,
    ]) {
      expect(REQUEST_SCHEMAS[command].parse({ id: 'term' })).toEqual({ id: 'term' })
    }
  })

  it.each([
    ['a missing request', CommandName.WorkspacesList, undefined, 'Invalid input: expected object, received undefined'],
    ['null', CommandName.UiStateGet, null, 'Invalid input: expected object, received null'],
    ['an array', CommandName.UiStateGet, [KEY], 'Invalid input: expected object, received array'],
    ['an unexpected field', CommandName.WorkspacesList, { all: true }, 'Unrecognized key: "all"'],
    ['unexpected fields', CommandName.UiStateGet, { key: KEY, a: 1, b: 2 }, 'Unrecognized keys: "a", "b"'],
    ['a missing key', CommandName.UiStateGet, {}, BAD_KEY],
    [
      'a search without its text',
      CommandName.SearchQuery,
      { workspaceId: 'w' },
      'text: Invalid input: expected string, received undefined',
    ],
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
    ['a missing task id', CommandName.TasksMarkDone, {}, 'id: Invalid input: expected string, received undefined'],
    [
      'a missing patch',
      CommandName.TasksUpdate,
      { id: 't' },
      'patch: Invalid input: expected object, received undefined',
    ],
    [
      'a patch to the state',
      CommandName.TasksUpdate,
      { id: 't', patch: { state: 'done' } },
      'patch: Unrecognized key: "state"',
    ],
    [
      "a patch to the agent's fields",
      CommandName.TasksUpdate,
      { id: 't', patch: { objective: 'x', status: 'y' } },
      'patch: Unrecognized keys: "objective", "status"',
    ],
    [
      'an unknown effort',
      CommandName.TasksUpdate,
      { id: 't', patch: { effort: 'huge' } },
      'patch.effort: Invalid option: expected one of "low"|"medium"|"high"|"max"',
    ],
    [
      'an empty model',
      CommandName.TasksUpdate,
      { id: 't', patch: { model: '' } },
      'patch.model: Too small: expected string to have >=1 characters',
    ],
    [
      'a blank title',
      CommandName.TasksUpdate,
      { id: 't', patch: { title: '  ' } },
      'patch.title: Expected a title that is not blank',
    ],
    [
      'a missing task id to delete',
      CommandName.TasksDelete,
      {},
      'id: Invalid input: expected string, received undefined',
    ],
    [
      'a blank message',
      CommandName.TasksSend,
      { id: 't', text: ' \n\t' },
      'text: Expected a message that is not blank',
    ],
    [
      'a message with no text',
      CommandName.TasksSend,
      { id: 't' },
      'text: Invalid input: expected string, received undefined',
    ],
    [
      'answers that are neither text nor a list of text',
      CommandName.QuestionsAnswer,
      { id: 's', answers: { 0: 1 } },
      'answers.0: Invalid input',
    ],
    [
      'answers as a list',
      CommandName.QuestionsAnswer,
      { id: 's', answers: ['by-type'] },
      'answers: Invalid input: expected record, received array',
    ],
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
    [
      'a terminal with no workspace said',
      CommandName.TerminalCreate,
      {},
      'workspaceId: Invalid input: expected string, received undefined',
    ],
    [
      'a folder for a new terminal: only a workspace names one',
      CommandName.TerminalCreate,
      { workspaceId: null, cwd: '/etc' },
      'Unrecognized key: "cwd"',
    ],
    [
      'a command to run: only typing reaches a shell',
      CommandName.TerminalWrite,
      { id: 'term', data: 'ls', command: 'rm -rf /' },
      'Unrecognized key: "command"',
    ],
    [
      'a write that is too long',
      CommandName.TerminalWrite,
      { id: 'term', data: 'x'.repeat(1_000_001) },
      'data: Too big: expected string to have <=1000000 characters',
    ],
    [
      'a terminal of no size',
      CommandName.TerminalAttach,
      { id: 'term', cols: 0, rows: 24 },
      'cols: Too small: expected number to be >=1',
    ],
    [
      'a terminal of part of a row',
      CommandName.TerminalResize,
      { id: 'term', cols: 80, rows: 2.5 },
      'rows: Invalid input: expected int, received number',
    ],
    [
      'a huge terminal',
      CommandName.TerminalResize,
      { id: 'term', cols: 80, rows: 5_000 },
      'rows: Too big: expected number to be <=2000',
    ],
    [
      'a blank terminal name',
      CommandName.TerminalRename,
      { id: 'term', name: ' ' },
      'name: Expected a name that is not blank',
    ],
    [
      'a terminal name that is too long',
      CommandName.TerminalRename,
      { id: 'term', name: 'x'.repeat(101) },
      'name: Too big: expected string to have <=100 characters',
    ],
    ['a missing terminal id', CommandName.TerminalClose, {}, 'id: Invalid input: expected string, received undefined'],
  ])('rejects %s, saying why in short', (_case, command, raw, message) => {
    const parsed = REQUEST_SCHEMAS[command].safeParse(raw)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(describeIssues(parsed.error)).toBe(message)
  })
})
