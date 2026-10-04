// The todo hub's commands over the bridge (P16, #494): the preload's `window.glade` over a fake IPC pair, against the
// real main-side registry, handlers and repositories on a temporary database. What a window can read and set while the
// hidden switch is on, what a bad payload gets (a bridge error, and main carries on), and that with the switch off
// both commands are refused and what the window already gets keeps its shape.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { ToolCallState, type Task } from '../../shared/domain'
import { ChildFilter, ChildKind, FilingSource, UNFILED_TODO_ID } from '../../shared/todoHub'
import { FakeAgentBackend } from '../agent/fake-backend'
import { addArtifact } from '../db/repositories/artifacts'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { fileChildren } from '../todo-hub/todo-hub'
import { fakeIpcPair } from './fake-ipc'
import { registerBridge } from '.'

let database: TestDatabase
let glade: GladeBridge
let task: Task
let events: GladeEvent[]
/** Sends the windows an event, as main's own services do. */
let emit: (event: GladeEvent) => void

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const ipc = fakeIpcPair()
  const bridge = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: new FakeAgentBackend(),
  })
  emit = bridge.emit
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
})

afterEach(() => {
  database.close()
})

/** A todo, as Claude Code's `TaskCreate` leaves it in the tool log. */
function createTodo(id: string, subject: string): void {
  const toolUseId = `toolu_create_${id}`
  appendToolCall(
    database.db,
    { taskId: task.id, turn: 1, name: 'TaskCreate', input: { subject }, toolUseId, parentToolUseId: null },
    3_000,
  )
  const output = `Task #${id} created successfully: ${subject}`
  updateToolCall(database.db, { taskId: task.id, toolUseId, state: ToolCallState.Done, output }, 3_000)
}

const hubRows = (): unknown =>
  database.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM child_ids) + (SELECT COUNT(*) FROM child_filings)
        + (SELECT COUNT(*) FROM todo_panels)`,
    )
    .pluck()
    .get()

describe('the switch the hub was built behind (#501)', () => {
  it('is no setting any more: the settings a window reads have none, and settings.update refuses it', async () => {
    expect((await glade.invoke(CommandName.SettingsGet, {})).settings).not.toHaveProperty('todoHubEnabled')

    await expect(
      // Bypassing the types, as a window from before the update could.
      glade.invoke(CommandName.SettingsUpdate, { patch: { todoHubEnabled: false } } as never),
    ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    expect(events).toEqual([])
  })

  it('is ignored when a database still has it stored as off: the hub answers all the same', async () => {
    database.db.prepare("INSERT INTO settings (key, value) VALUES ('todoHubEnabled', 'false')").run()

    await expect(glade.invoke(CommandName.TodoHubGet, { taskId: task.id })).resolves.toMatchObject({ filings: [] })
    await expect(
      glade.invoke(CommandName.TodoHubSetPanel, { taskId: task.id, todoId: '1', open: true, filter: ChildFilter.All }),
    ).resolves.toBeNull()
    expect((await glade.invoke(CommandName.SettingsGet, {})).settings).not.toHaveProperty('todoHubEnabled')
  })
})

describe('todoHub.get', () => {
  it('answers with the task’s children grouped by todo, its filings and its panels', async () => {
    createTodo('1', 'Plan the move')
    createTodo('2', 'Copy the files')
    addArtifact(database.db, { taskId: task.id, path: 'docs/plan.md', title: 'The plan' }, 4_000)
    addArtifact(database.db, { taskId: task.id, path: 'docs/notes.md', title: 'Notes' }, 4_100)
    const plan = { kind: ChildKind.File, key: 'docs/plan.md' }
    fileChildren({ db: database.db, emit }, task.id, [{ ...plan, todoId: '2', source: FilingSource.Named }], 5_000)
    await glade.invoke(CommandName.TodoHubSetPanel, {
      taskId: task.id,
      todoId: '2',
      open: true,
      filter: ChildFilter.Files,
    })

    const hub = await glade.invoke(CommandName.TodoHubGet, { taskId: task.id })

    // A count for each kind a todo shows: files, links and commits, and nothing for a subagent or a watcher.
    const tallies = { [ChildKind.File]: 0, [ChildKind.Link]: 0, [ChildKind.Commit]: 0 }
    expect(hub).toEqual({
      children: {
        todos: [
          { todoId: '1', children: [], tallies },
          {
            todoId: '2',
            children: [{ ...plan, updatedAt: 4_000, source: FilingSource.Named }],
            tallies: { ...tallies, [ChildKind.File]: 1 },
          },
        ],
        unfiled: {
          todoId: UNFILED_TODO_ID,
          children: [{ kind: ChildKind.File, key: 'docs/notes.md', updatedAt: 4_100, source: null }],
          tallies: { ...tallies, [ChildKind.File]: 1 },
        },
      },
      filings: [{ taskId: task.id, ...plan, todoId: '2', source: FilingSource.Named, filedAt: 5_000 }],
      panels: [{ taskId: task.id, todoId: '2', open: true, filter: ChildFilter.Files }],
    })
  })

  it('hears what was filed as it happens: the change alone', async () => {
    const plan = { kind: ChildKind.File, key: 'docs/plan.md' }

    const filed = fileChildren({ db: database.db, emit }, task.id, [
      { ...plan, todoId: '1', source: FilingSource.Asked },
    ])

    expect(events).toEqual([{ type: EventType.FilingsChanged, taskId: task.id, filed, removed: [] }])
  })

  it('fails for a task that isn’t there', async () => {
    await expect(glade.invoke(CommandName.TodoHubGet, { taskId: 'gone' })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })
})

describe('todoHub.setPanel', () => {
  it('remembers each todo’s panel, and the placeholder’s, without telling the windows', async () => {
    const panels = [
      { taskId: task.id, todoId: '1', open: true, filter: ChildFilter.All },
      { taskId: task.id, todoId: '3', open: false, filter: ChildFilter.Links },
      { taskId: task.id, todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.Commits },
    ]

    for (const panel of panels) await expect(glade.invoke(CommandName.TodoHubSetPanel, panel)).resolves.toBeNull()
    // Back to how it starts: forgotten.
    await glade.invoke(CommandName.TodoHubSetPanel, { ...panels[0], open: false } as (typeof panels)[number])

    expect((await glade.invoke(CommandName.TodoHubGet, { taskId: task.id })).panels).toEqual(panels.slice(1))
    expect(events).toEqual([])
  })

  it('fails for a task that isn’t there', async () => {
    await expect(
      glade.invoke(CommandName.TodoHubSetPanel, { taskId: 'gone', todoId: '1', open: true, filter: ChildFilter.All }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
  })
})

describe('a bad payload', () => {
  const panel = { taskId: 'task', todoId: '1', open: true, filter: ChildFilter.All }
  const bad: readonly [CommandName.TodoHubGet | CommandName.TodoHubSetPanel, unknown, string][] = [
    [CommandName.TodoHubGet, {}, 'taskId'],
    [CommandName.TodoHubGet, { taskId: 7 }, 'taskId'],
    [CommandName.TodoHubGet, { taskId: 'task', todoId: '1' }, 'Unrecognized key'],
    [CommandName.TodoHubGet, null, 'expected object'],
    [CommandName.TodoHubGet, 'task', 'expected object'],
    [CommandName.TodoHubSetPanel, {}, 'taskId'],
    [CommandName.TodoHubSetPanel, { ...panel, todoId: '' }, 'todoId'],
    [CommandName.TodoHubSetPanel, { ...panel, todoId: 1 }, 'todoId'],
    [CommandName.TodoHubSetPanel, { ...panel, open: 'yes' }, 'open'],
    [CommandName.TodoHubSetPanel, { ...panel, filter: 'images' }, 'filter'],
    [CommandName.TodoHubSetPanel, { ...panel, filter: undefined }, 'filter'],
    [CommandName.TodoHubSetPanel, { ...panel, pinned: true }, 'Unrecognized key'],
    [CommandName.TodoHubSetPanel, [panel], 'expected object'],
  ]

  it.each(bad)('to %s (%j) is a bridge error naming %s, and nothing is written', async (command, request, names) => {
    // Bypassing the types, as a buggy or compromised window could.
    await expect(glade.invoke(command, request as never)).rejects.toMatchObject({
      name: 'BridgeError',
      code: BridgeErrorCode.InvalidRequest,
      message: expect.stringContaining(names) as unknown,
    })

    expect(hubRows()).toBe(0)
    expect(events).toEqual([])
    // Main is still there: the next command is answered.
    await expect(glade.invoke(CommandName.TodoHubGet, { taskId: task.id })).resolves.toMatchObject({ filings: [] })
  })
})
