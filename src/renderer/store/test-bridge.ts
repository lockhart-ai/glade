// Test helpers: an in-memory stand-in for main behind `window.glade`, and made-up sample data.
import { vi } from 'vitest'
import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  EventType,
  type CommandRequest,
  type CommandResponse,
  type BridgeError,
  type EventListener,
  type GladeBridge,
  type GladeEvent,
} from '../../shared/bridge'
import {
  Effort,
  MessageRole,
  TaskActivity,
  TaskState,
  type Message,
  type Task,
  type ToolEvent,
  type UiStateEntry,
  type Workspace,
} from '../../shared/domain'

export type FakeHandlers = {
  readonly [C in CommandName]: (request: CommandRequest<C>) => CommandResponse<C> | Promise<CommandResponse<C>>
}

export interface FakeMain {
  readonly workspaces: Workspace[]
  readonly tasks: Task[]
  readonly uiState: UiStateEntry[]
  /** Every task's chat messages; none when left out. */
  readonly messages?: Message[]
  /** Every task's tool log entries; none when left out. */
  readonly toolEvents?: ToolEvent[]
}

export interface FakeBridge {
  readonly bridge: GladeBridge
  readonly invoke: ReturnType<typeof vi.fn<GladeBridge['invoke']>>
  /** Sends an event to every subscriber, as main would. */
  readonly emit: (event: GladeEvent) => void
  readonly listenerCount: () => number
}

/**
 * Handlers answering from `main`, which `uiState.set` and the task commands write to (and broadcast through `emit`)
 * like main does. The task commands don't check transitions, `tasks.send` only saves and broadcasts the message, and
 * `tasks.stop` only sets the task back to waiting; main's own tests cover the rest. `workspaces.create` adds a
 * workspace and `workspaces.open` answers with it opened at 5,000, neither broadcasting.
 */
export function fakeHandlers(main: FakeMain, emit: (event: GladeEvent) => void): FakeHandlers {
  let sent = 0
  const writeTask = (id: string, change: Partial<Task>): { task: Task } => {
    const index = main.tasks.findIndex((task) => task.id === id)
    const current = main.tasks[index]
    if (current === undefined) throw new Error(`No task ${id}`)
    const task = { ...current, ...change }
    main.tasks[index] = task
    emit({ type: EventType.TaskUpdated, task })
    return { task }
  }
  return {
    [CommandName.WorkspacesList]: () => ({ workspaces: [...main.workspaces] }),
    // Workspace commands answer without broadcasting, so tests see the store apply the answer itself.
    [CommandName.WorkspacesCreate]: ({ rootPath }) => {
      const workspace = { ...sampleWorkspace(`w${String(main.workspaces.length + 1)}`), rootPath }
      main.workspaces.push(workspace)
      return { workspace, created: true }
    },
    [CommandName.WorkspacesOpen]: ({ id }) => {
      const current = main.workspaces.find((workspace) => workspace.id === id)
      if (current === undefined) return refuse(bridgeError(BridgeErrorCode.NotFound, `No workspace ${id}`))
      return { workspace: { ...current, lastOpenedAt: 5_000 } }
    },
    [CommandName.DialogChooseFolder]: () => ({ path: null }),
    [CommandName.TasksList]: ({ workspaceId }) => ({
      tasks: main.tasks.filter((task) => task.workspaceId === workspaceId),
    }),
    [CommandName.TasksCreate]: ({ workspaceId }) => {
      const task = sampleTask(`task-${String(main.tasks.length + 1)}`, workspaceId, '')
      main.tasks.push(task)
      emit({ type: EventType.TaskUpdated, task })
      return { task }
    },
    [CommandName.TasksMarkDone]: ({ id }) => writeTask(id, { state: TaskState.Done, doneAt: 3_000 }),
    [CommandName.TasksReopen]: ({ id }) => writeTask(id, { state: TaskState.Active, doneAt: null }),
    [CommandName.TasksUpdate]: ({ id, patch }) => writeTask(id, patch),
    [CommandName.TasksSend]: ({ id, text }) => {
      sent += 1
      const message = sampleMessage(`sent-${String(sent)}`, id, text)
      main.messages?.push(message)
      emit({ type: EventType.MessageAppended, message })
      return { message }
    },
    [CommandName.TasksStop]: ({ id }) => writeTask(id, { activity: TaskActivity.Waiting }),
    [CommandName.TasksHistory]: ({ id }) => ({
      messages: (main.messages ?? []).filter((message) => message.taskId === id),
      toolEvents: (main.toolEvents ?? []).filter((event) => event.taskId === id),
    }),
    [CommandName.UiStateGet]: ({ key }) => ({ value: main.uiState.find((entry) => entry.key === key)?.value ?? null }),
    [CommandName.UiStateGetAll]: () => ({ entries: [...main.uiState] }),
    [CommandName.UiStateSet]: (entry) => {
      const index = main.uiState.findIndex(({ key }) => key === entry.key)
      if (index === -1) main.uiState.push(entry)
      else main.uiState[index] = entry
      emit({ type: EventType.UiStateChanged, entry })
      return null
    },
  }
}

/** A bridge over `main`'s data. Pass `overrides` to change how single commands answer. */
export function fakeBridge(main: FakeMain, overrides: Partial<FakeHandlers> = {}): FakeBridge {
  const listeners = new Set<EventListener>()
  const emit = (event: GladeEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const handlers: FakeHandlers = { ...fakeHandlers(main, emit), ...overrides }
  const invoke = vi.fn<GladeBridge['invoke']>(async (command, request) => handlers[command](request))
  return {
    bridge: {
      invoke,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    invoke,
    emit,
    listenerCount: () => listeners.size,
  }
}

/** How main answers a failed command: `invoke` rejects with the `BridgeError`, a plain object rather than an Error. */
export function refuse(error: BridgeError): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return Promise.reject(error)
}

export function sampleWorkspace(id: string, name = 'Acme API'): Workspace {
  return { id, name, rootPath: `/code/${id}`, createdAt: 1_000, lastOpenedAt: 1_000 }
}

export function sampleTask(id: string, workspaceId: string, title = 'Add rate limiting'): Task {
  return {
    id,
    workspaceId,
    title,
    objective: '',
    status: '',
    state: TaskState.Active,
    activity: TaskActivity.Waiting,
    pinned: false,
    unread: false,
    model: 'claude-sample-1',
    effort: Effort.Medium,
    createdAt: 2_000,
    updatedAt: 2_000,
    doneAt: null,
    sessionId: null,
  }
}

export function sampleMessage(id: string, taskId: string, body = 'Add rate limiting to the public API.'): Message {
  return { id, taskId, role: MessageRole.User, body, turn: 1, createdAt: 3_000 }
}
