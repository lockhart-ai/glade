import { describe, expect, it } from 'vitest'
import { CommandName, RendererErrorKind } from '../../shared/bridge'
import { TaskFilter } from '../../shared/attention'
import { MAX_DONE_PAGE_SIZE } from '../../shared/doneList'
import { Effort, PermissionDecisionKind, PermissionMode, UiStateKey } from '../../shared/domain'
import { MAX_IMAGE_BASE64_LENGTH, MAX_IMAGE_BYTES } from '../../shared/images'
import { GIF, JPEG, PNG, WEBP } from '../../shared/test-images'
import { describeIssues, REQUEST_SCHEMAS } from './requests'

const KEY = UiStateKey.ActiveWorkspaceId
const BAD_KEY =
  'key: Invalid option: expected one of "active_workspace_id"|"selected_task_id"|"pinned_section_collapsed"|"active_section_collapsed"|"done_section_collapsed"|"task_filter"|"relaunch_notice"|"right_panel_tab"|"right_panel_width"|"right_panel_collapsed"|"sidebar_collapsed"|"sidebar_width"|"bottom_bar_collapsed"|"bottom_bar_height"|"plugin_width"|"terminal_tab"'

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
    expect(REQUEST_SCHEMAS[CommandName.TasksListActive].parse({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' })
    const page = { workspaceId: 'w', filter: TaskFilter.Unread, after: { updatedAt: 5, id: 't' }, limit: 100 }
    expect(REQUEST_SCHEMAS[CommandName.TasksListDone].parse(page)).toEqual(page)
    expect(REQUEST_SCHEMAS[CommandName.TasksGet].parse({ ids: ['t'] })).toEqual({ ids: ['t'] })
    expect(REQUEST_SCHEMAS[CommandName.TasksCreate].parse({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' })
    expect(REQUEST_SCHEMAS[CommandName.TasksMarkDone].parse({ id: 't' })).toEqual({ id: 't' })
    expect(REQUEST_SCHEMAS[CommandName.TasksReopen].parse({ id: 't' })).toEqual({ id: 't' })
    const patch = {
      title: 'Rate limits',
      pinned: true,
      unread: false,
      model: 'claude-sample-2',
      effort: Effort.Max,
      permissionMode: PermissionMode.AskBeforeEdits,
    }
    expect(REQUEST_SCHEMAS[CommandName.TasksUpdate].parse({ id: 't', patch })).toEqual({ id: 't', patch })
    expect(REQUEST_SCHEMAS[CommandName.TasksUpdate].parse({ id: 't', patch: {} })).toEqual({ id: 't', patch: {} })
    const send = { id: 't', text: ' Fix the **flaky** test.\n' }
    expect(REQUEST_SCHEMAS[CommandName.TasksSend].parse(send)).toEqual(send)
    expect(REQUEST_SCHEMAS[CommandName.TasksHistory].parse({ id: 't' })).toEqual({ id: 't' })
    const answer = { id: 's', answers: { 0: 'by-type', 1: ['Features', 'Fixes'], 2: '' } }
    expect(REQUEST_SCHEMAS[CommandName.QuestionsAnswer].parse(answer)).toEqual(answer)
    for (const decision of [
      { kind: PermissionDecisionKind.AllowOnce },
      { kind: PermissionDecisionKind.AllowForTask },
      { kind: PermissionDecisionKind.Deny },
      { kind: PermissionDecisionKind.Deny, note: 'Use pnpm.' },
    ]) {
      expect(REQUEST_SCHEMAS[CommandName.PermissionsAnswer].parse({ id: 'p', decision })).toEqual({ id: 'p', decision })
    }
    expect(REQUEST_SCHEMAS[CommandName.UiStateGet].parse({ key: KEY })).toEqual({ key: KEY })
    expect(REQUEST_SCHEMAS[CommandName.UiStateGetAll].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.UiStateSet].parse({ key: KEY, value: '' })).toEqual({ key: KEY, value: '' })
    const rename = { id: 'w', patch: { name: ' Acme ', rootPath: '/code/acme' } }
    expect(REQUEST_SCHEMAS[CommandName.WorkspacesUpdate].parse(rename)).toEqual(rename)
    expect(REQUEST_SCHEMAS[CommandName.SettingsGet].parse({})).toEqual({})
    const settings = {
      patch: {
        defaultModel: 'claude-sonnet-5',
        defaultEffort: Effort.Low,
        statusSummary: false,
        taskTitles: false,
        notifications: false,
        notificationSound: true,
      },
    }
    expect(REQUEST_SCHEMAS[CommandName.SettingsUpdate].parse(settings)).toEqual(settings)
    expect(REQUEST_SCHEMAS[CommandName.SettingsUpdate].parse({ patch: {} })).toEqual({ patch: {} })
    const search = { workspaceId: 'w', text: '"Retry-After' }
    expect(REQUEST_SCHEMAS[CommandName.SearchQuery].parse(search)).toEqual(search)
    expect(REQUEST_SCHEMAS[CommandName.PluginsList].parse({})).toEqual({})
    expect(REQUEST_SCHEMAS[CommandName.PluginsOpenFolder].parse({})).toEqual({})
    const toggle = { id: 'pomodoro', enabled: false }
    expect(REQUEST_SCHEMAS[CommandName.PluginsSetEnabled].parse(toggle)).toEqual(toggle)
  })

  it('refuses a Done page of no tasks, too many, an unknown filter or a malformed cursor', () => {
    const page = { workspaceId: 'w', filter: TaskFilter.All, after: null, limit: 100 }
    const schema = REQUEST_SCHEMAS[CommandName.TasksListDone]

    expect(schema.safeParse({ ...page, limit: 0 }).success).toBe(false)
    expect(schema.safeParse({ ...page, limit: MAX_DONE_PAGE_SIZE + 1 }).success).toBe(false)
    expect(schema.safeParse({ ...page, filter: 'everything' }).success).toBe(false)
    expect(schema.safeParse({ ...page, after: { updatedAt: -1, id: 't' } }).success).toBe(false)
    expect(schema.safeParse({ ...page, after: { id: 't' } }).success).toBe(false)
  })

  it('parses messages with images, in order, and messages that are only images', () => {
    const send = { id: 't', text: 'Compare these.', images: [PNG, JPEG, GIF, WEBP] }
    expect(REQUEST_SCHEMAS[CommandName.TasksSend].parse(send)).toEqual(send)
    const imagesOnly = { id: 't', text: '', images: [PNG] }
    expect(REQUEST_SCHEMAS[CommandName.TasksSend].parse(imagesOnly)).toEqual(imagesOnly)
    const queued = { taskId: 't', text: ' ', images: [GIF, GIF] }
    expect(REQUEST_SCHEMAS[CommandName.QueueAdd].parse(queued)).toEqual(queued)
    const textOnly = { taskId: 't', text: 'Keep the filenames.', images: [] }
    expect(REQUEST_SCHEMAS[CommandName.QueueAdd].parse(textOnly)).toEqual(textOnly)
    expect(REQUEST_SCHEMAS[CommandName.ImagesGet].parse({ id: 'i' })).toEqual({ id: 'i' })
  })

  it('parses drafts: any text, blank included, with or without their images', () => {
    expect(REQUEST_SCHEMAS[CommandName.DraftsGet].parse({ taskId: 't' })).toEqual({ taskId: 't' })
    for (const draft of [
      { taskId: 't', text: '' },
      { taskId: 't', text: '  \n' },
      { taskId: 't', text: '', images: [] },
      { taskId: 't', text: 'See these', images: [PNG, GIF] },
    ]) {
      expect(REQUEST_SCHEMAS[CommandName.DraftsSet].parse(draft)).toEqual(draft)
    }
    expect(() => REQUEST_SCHEMAS[CommandName.DraftsSet].parse({ taskId: 't' })).toThrow()
    expect(() =>
      REQUEST_SCHEMAS[CommandName.DraftsSet].parse({ taskId: 't', text: '', images: [{ ...PNG, data: JPEG.data }] }),
    ).toThrow(/bytes to be its type/)
    expect(() => REQUEST_SCHEMAS[CommandName.DraftsSet].parse({ taskId: 't', text: '', extra: 1 })).toThrow()
  })

  it('takes an image right up to the API’s size limit', () => {
    const png = Buffer.from(PNG.data, 'base64')
    const data = Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES - png.length)]).toString('base64')
    expect(data).toHaveLength(MAX_IMAGE_BASE64_LENGTH)
    const send = { id: 't', text: '', images: [{ mediaType: PNG.mediaType, data }] }
    expect(REQUEST_SCHEMAS[CommandName.TasksSend].safeParse(send).success).toBe(true)
  })

  it('parses an error the window sends to the log', () => {
    const error = {
      kind: RendererErrorKind.Error,
      message: 'TypeError: task is undefined',
      stack: 'TypeError: task is undefined\n    at TaskHeader',
      componentStack: null,
      source: 'index.js:10:4',
    }
    expect(REQUEST_SCHEMAS[CommandName.LogRendererError].parse(error)).toEqual(error)
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
      'a plugin toggle without its state',
      CommandName.PluginsSetEnabled,
      { id: 'pomodoro' },
      'enabled: Invalid input: expected boolean, received undefined',
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
    [
      'a blank workspace name',
      CommandName.WorkspacesUpdate,
      { id: 'w', patch: { name: ' ' } },
      'patch.name: Expected a name that is not blank',
    ],
    [
      'a relative new root',
      CommandName.WorkspacesUpdate,
      { id: 'w', patch: { rootPath: 'acme' } },
      'patch.rootPath: Expected an absolute path',
    ],
    [
      'an unknown setting',
      CommandName.SettingsUpdate,
      { patch: { theme: 'light' } },
      'patch: Unrecognized key: "theme"',
    ],
    [
      'a setting of the wrong type',
      CommandName.SettingsUpdate,
      { patch: { notifications: 'off' } },
      'patch.notifications: Invalid input: expected boolean, received string',
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
      'patch.effort: Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"',
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
      'a blank message with no images',
      CommandName.TasksSend,
      { id: 't', text: ' ', images: [] },
      'text: Expected a message that is not blank',
    ],
    [
      'a blank queued message',
      CommandName.QueueAdd,
      { taskId: 't', text: '' },
      'text: Expected a message that is not blank',
    ],
    [
      'an image of a type the agent doesn’t take',
      CommandName.TasksSend,
      { id: 't', text: 'Scan', images: [{ mediaType: 'image/tiff', data: PNG.data }] },
      'images.0.mediaType: Invalid option: expected one of "image/png"|"image/jpeg"|"image/gif"|"image/webp"',
    ],
    [
      'an image over the API’s size limit',
      CommandName.QueueAdd,
      { taskId: 't', text: '', images: [{ mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 4) }] },
      'images.0.data: Too big: expected string to have <=5242880 characters',
    ],
    [
      'an image that isn’t base64',
      CommandName.TasksSend,
      { id: 't', text: 'Hi', images: [{ mediaType: 'image/png', data: 'not base64!' }] },
      'images.0.data: Expected base64',
    ],
    [
      'an empty image',
      CommandName.TasksSend,
      { id: 't', text: 'Hi', images: [{ mediaType: 'image/png', data: '' }] },
      'images.0.data: Too small: expected string to have >=1 characters',
    ],
    [
      'an image whose bytes are another type',
      CommandName.TasksSend,
      { id: 't', text: 'Hi', images: [{ mediaType: 'image/png', data: JPEG.data }] },
      "images.0: Expected the image's bytes to be its type",
    ],
    [
      'an image with fields it doesn’t have',
      CommandName.QueueAdd,
      { taskId: 't', text: 'Hi', images: [{ ...GIF, name: 'shot.gif' }] },
      'images.0: Unrecognized key: "name"',
    ],
    ['a missing image id', CommandName.ImagesGet, {}, 'id: Invalid input: expected string, received undefined'],
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
    [
      'a permission decision it doesn’t know',
      CommandName.PermissionsAnswer,
      { id: 'p', decision: { kind: 'allow_forever' } },
      "decision.kind: Invalid discriminator value. Expected 'allow_once' | 'allow_for_task' | 'deny'",
    ],
    [
      'a note on Allow once',
      CommandName.PermissionsAnswer,
      { id: 'p', decision: { kind: PermissionDecisionKind.AllowOnce, note: 'Sure.' } },
      'decision: Unrecognized key: "note"',
    ],
    [
      'a permission mode it doesn’t know',
      CommandName.TasksUpdate,
      { id: 't', patch: { permissionMode: 'ask_sometimes' } },
      'patch.permissionMode: Invalid option: expected one of "allow_all"|"ask_before_edits"',
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
    [
      'a renderer error of a kind there is none of',
      CommandName.LogRendererError,
      { kind: 'bad', message: 'x', stack: null, componentStack: null, source: null },
      'kind: Invalid option: expected one of "error"|"unhandled_rejection"|"react_uncaught"|"react_caught"|"react_recoverable"',
    ],
    [
      'a renderer error with too much text',
      CommandName.LogRendererError,
      { kind: 'error', message: 'x'.repeat(10_001), stack: null, componentStack: null, source: null },
      'message: Too big: expected string to have <=10000 characters',
    ],
  ])('rejects %s, saying why in short', (_case, command, raw, message) => {
    const parsed = REQUEST_SCHEMAS[command].safeParse(raw)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(describeIssues(parsed.error)).toBe(message)
  })
})

describe('the Changes tab’s requests', () => {
  const KEY = '/commit/c1/docs/upgrading.md'

  it('take a commit file’s key where the Files tab can have one open, and nowhere else', () => {
    for (const command of [CommandName.FilesRead, CommandName.FilesOpen, CommandName.FilesClose] as const) {
      expect(REQUEST_SCHEMAS[command].parse({ taskId: 't', path: KEY })).toEqual({ taskId: 't', path: KEY })
      expect(REQUEST_SCHEMAS[command].parse({ taskId: 't', path: 'src/date.ts' })).toEqual({
        taskId: 't',
        path: 'src/date.ts',
      })
      expect(REQUEST_SCHEMAS[command].safeParse({ taskId: 't', path: '/commit/c1/../secrets' }).success).toBe(false)
      expect(REQUEST_SCHEMAS[command].safeParse({ taskId: 't', path: '/etc/hosts' }).success).toBe(false)
    }
    for (const command of [CommandName.FilesOpenInEditor, CommandName.FilesReveal, CommandName.FilesCopy] as const) {
      expect(REQUEST_SCHEMAS[command].safeParse({ taskId: 't', path: KEY }).success).toBe(false)
    }
  })

  it('name a commit by its id, and a file by its path in the commit’s repository', () => {
    expect(REQUEST_SCHEMAS[CommandName.ChangesFiles].parse({ taskId: 't', id: 'c1' })).toEqual({
      taskId: 't',
      id: 'c1',
    })
    const open = { taskId: 't', id: 'c1', path: 'docs/upgrading.md' }
    expect(REQUEST_SCHEMAS[CommandName.ChangesOpenFile].parse(open)).toEqual(open)
    expect(REQUEST_SCHEMAS[CommandName.ChangesOpenFile].safeParse({ ...open, path: '../x' }).success).toBe(false)
    expect(REQUEST_SCHEMAS[CommandName.ChangesRepository].parse({ taskId: 't' })).toEqual({ taskId: 't' })
    expect(REQUEST_SCHEMAS[CommandName.ChangesRepository].safeParse({ id: 't' }).success).toBe(false)
  })
})
