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
  FileContentKind,
  FileInfoKind,
  MessageRole,
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  TaskState,
  type Artifact,
  type FileContent,
  type FileInfo,
  type Message,
  type OpenFiles,
  type QuestionSet,
  type QueuedMessage,
  type Task,
  type TodoList,
  type ToolEvent,
  type UiStateEntry,
  type Workspace,
} from '../../shared/domain'
import { noOpenFiles, withClosedFile, withOpenedFile } from '../../shared/files'
import { highlightParts, highlightPattern, SearchField, type SearchResult } from '../../shared/search'
import type { TerminalTab } from '../../shared/terminal'

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
  /** Every task's queued messages; none when left out. */
  readonly queuedMessages?: QueuedMessage[]
  /** Every task's question sets; none when left out. `questions.answer` answers one, without checking the answers. */
  readonly questionSets?: QuestionSet[]
  /** Every task's open files; none when left out. `files.open` and `files.close` change them. */
  readonly openFiles?: OpenFiles[]
  /** What `files.read` answers with, by path, for any task; missing when left out. */
  readonly files?: Readonly<Record<string, FileContent>>
  /** The paths `files.openInEditor` opened, oldest first. */
  readonly openedInEditor?: string[]
  /** The subagents `subagents.stop` stopped, by their `Agent` calls' tool_use ids, oldest first. */
  readonly stoppedSubagents?: string[]
  /** Each task's todo list, by task id; none when left out. */
  readonly todos?: Readonly<Record<string, TodoList>>
  /** Every task's artifacts; none when left out. `artifacts.remove` removes one, from the fake's own copy. */
  readonly artifacts?: readonly Artifact[]
  /** What `files.info` answers with, by path, for any task; missing when left out. */
  readonly fileInfo?: Readonly<Record<string, FileInfo>>
  /** What was put on the clipboard, oldest first: the path of each file `files.copy` copied, and the text of each
   * `clipboard.writeText`. */
  readonly copied?: string[]
  /** The paths `files.reveal` revealed, oldest first. */
  readonly revealed?: string[]
  /** The task last selected in each workspace, by workspace id, which `workspaces.open` selects; none when left out. */
  readonly workspaceSelections?: Readonly<Record<string, string>>
  /** The workspaces `workspaces.reveal` revealed, by id, oldest first. */
  readonly revealedWorkspaces?: string[]
  /**
   * The terminal tabs, in order; none when left out. `terminal.create` adds `term-1`, `term-2`… at the end (starting in
   * the workspace's root, or `/Users/sample`), `terminal.duplicate` after the tab, and `terminal.rename` and
   * `terminal.close` change them, each broadcasting them.
   */
  readonly terminalTabs?: TerminalTab[]
  /** What `terminal.attach` answers with, by tab id: empty when left out. */
  readonly terminalOutput?: Readonly<Record<string, string>>
  /**
   * The terminal commands that don't change the tabs, oldest first, each as its name, tab and arguments:
   * `attach term-1 80x24`, `write term-1 ls`, `resize term-1 100x30`, `clear term-1`, `interrupt term-1`.
   */
  readonly terminalCalls?: string[]
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
 * `tasks.stop` only sets the task back to waiting, `tasks.compact` only sets it working, and `tasks.delete` only
 * removes the task and broadcasts it, without deselecting it; main's own tests cover the rest. `workspaces.create` adds a
 * workspace and `workspaces.open` answers with it opened at 5,000 and its selection from `workspaceSelections`, neither
 * broadcasting.
 */
export function fakeHandlers(main: FakeMain, emit: (event: GladeEvent) => void): FakeHandlers {
  let sent = 0
  let queued = 0
  const queue = main.queuedMessages ?? []
  const queueOf = (taskId: string): QueuedMessage[] => queue.filter((message) => message.taskId === taskId)
  const queueChanged = (taskId: string): void => {
    emit({ type: EventType.QueueChanged, taskId, queuedMessages: queueOf(taskId) })
  }
  const notQueued = (id: string): Promise<never> =>
    refuse(bridgeError(BridgeErrorCode.NotFound, `No queued message ${id}`))
  const openFiles = main.openFiles ?? []
  const artifacts = [...(main.artifacts ?? [])]
  const openFilesOf = (taskId: string): OpenFiles =>
    openFiles.find((open) => open.taskId === taskId) ?? noOpenFiles(taskId)
  const changeOpenFiles = (taskId: string, change: (open: OpenFiles) => OpenFiles): { openFiles: OpenFiles } => {
    const changed = change(openFilesOf(taskId))
    const index = openFiles.findIndex((open) => open.taskId === taskId)
    if (index === -1) openFiles.push(changed)
    else openFiles[index] = changed
    emit({ type: EventType.OpenFilesChanged, openFiles: changed })
    return { openFiles: changed }
  }
  const writeTask = (id: string, change: Partial<Task>): { task: Task } => {
    const index = main.tasks.findIndex((task) => task.id === id)
    const current = main.tasks[index]
    if (current === undefined) throw new Error(`No task ${id}`)
    const task = { ...current, ...change }
    main.tasks[index] = task
    emit({ type: EventType.TaskUpdated, task })
    return { task }
  }
  const terminalTabs = main.terminalTabs ?? []
  const terminalCalls = main.terminalCalls ?? []
  let terminals = 0
  const tabsChanged = (): void => {
    emit({ type: EventType.TerminalTabsChanged, tabs: [...terminalTabs] })
  }
  const terminalAt = (id: string): { index: number; tab: TerminalTab } => {
    const index = terminalTabs.findIndex((tab) => tab.id === id)
    const tab = terminalTabs[index]
    if (tab === undefined) throw new Error(`No terminal tab ${id}`)
    return { index, tab }
  }
  const addTerminal = (tab: Omit<TerminalTab, 'id'>, at: number): { tab: TerminalTab } => {
    terminals += 1
    const added = { ...tab, id: `term-${String(terminals)}` }
    terminalTabs.splice(at, 0, added)
    tabsChanged()
    return { tab: added }
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
      return { workspace: { ...current, lastOpenedAt: 5_000 }, selectedTaskId: main.workspaceSelections?.[id] ?? null }
    },
    [CommandName.WorkspacesReveal]: ({ id }) => {
      if (!main.workspaces.some((workspace) => workspace.id === id)) {
        return refuse(bridgeError(BridgeErrorCode.NotFound, `No workspace ${id}`))
      }
      main.revealedWorkspaces?.push(id)
      return null
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
    [CommandName.TasksDelete]: ({ id }) => {
      const index = main.tasks.findIndex((task) => task.id === id)
      if (index === -1) return refuse(bridgeError(BridgeErrorCode.NotFound, `No task ${id}`))
      main.tasks.splice(index, 1)
      emit({ type: EventType.TaskDeleted, taskId: id })
      return null
    },
    [CommandName.TasksSend]: ({ id, text }) => {
      sent += 1
      const message = sampleMessage(`sent-${String(sent)}`, id, text)
      main.messages?.push(message)
      emit({ type: EventType.MessageAppended, message })
      return { message }
    },
    [CommandName.TasksStop]: ({ id }) => writeTask(id, { activity: TaskActivity.Waiting }),
    [CommandName.TasksRetry]: ({ id, model }) =>
      writeTask(id, {
        activity: TaskActivity.Working,
        error: null,
        pause: null,
        ...(model === undefined ? {} : { model }),
      }),
    [CommandName.TasksCompact]: ({ id }) => writeTask(id, { activity: TaskActivity.Working }),
    [CommandName.TasksHistory]: ({ id }) => ({
      messages: (main.messages ?? []).filter((message) => message.taskId === id),
      toolEvents: (main.toolEvents ?? []).filter((event) => event.taskId === id),
      queuedMessages: queueOf(id),
      questionSets: (main.questionSets ?? []).filter((set) => set.taskId === id),
      openFiles: openFilesOf(id),
      todos: main.todos?.[id] ?? null,
      artifacts: artifacts.filter((artifact) => artifact.taskId === id),
    }),
    [CommandName.QueueAdd]: ({ taskId, text }) => {
      queued += 1
      const queuedMessage = sampleQueuedMessage(`queued-${String(queued)}`, taskId, text)
      queue.push(queuedMessage)
      queueChanged(taskId)
      return { queuedMessage }
    },
    [CommandName.QueueEdit]: ({ id, text }) => {
      const index = queue.findIndex((message) => message.id === id)
      const current = queue[index]
      if (current === undefined) return notQueued(id)
      const queuedMessage = { ...current, body: text }
      queue[index] = queuedMessage
      queueChanged(queuedMessage.taskId)
      return { queuedMessage }
    },
    [CommandName.QueueRemove]: ({ id }) => {
      const index = queue.findIndex((message) => message.id === id)
      const [removed] = index === -1 ? [] : queue.splice(index, 1)
      if (removed === undefined) return notQueued(id)
      queueChanged(removed.taskId)
      return null
    },
    [CommandName.QuestionsAnswer]: ({ id, answers }) => {
      const sets = main.questionSets ?? []
      const index = sets.findIndex((set) => set.id === id)
      const current = sets[index]
      if (current === undefined) return refuse(bridgeError(BridgeErrorCode.NotFound, `No question set ${id}`))
      const questionSet: QuestionSet = {
        ...current,
        state: QuestionSetState.Answered,
        reply: { kind: QuestionReplyKind.Answers, answers },
        closedAt: 3_000,
      }
      sets[index] = questionSet
      emit({ type: EventType.QuestionAnswered, questionSet })
      return { questionSet }
    },
    [CommandName.FilesRead]: ({ path }) => ({ content: main.files?.[path] ?? { kind: FileContentKind.Missing } }),
    [CommandName.FilesOpen]: ({ taskId, path }) => changeOpenFiles(taskId, (open) => withOpenedFile(open, path)),
    [CommandName.FilesClose]: ({ taskId, path }) => changeOpenFiles(taskId, (open) => withClosedFile(open, path)),
    [CommandName.FilesOpenInEditor]: ({ path }) => {
      main.openedInEditor?.push(path)
      return null
    },
    [CommandName.SubagentsStop]: ({ toolUseId }) => {
      main.stoppedSubagents?.push(toolUseId)
      return null
    },
    [CommandName.FilesInfo]: ({ path }) => ({ info: main.fileInfo?.[path] ?? { kind: FileInfoKind.Missing } }),
    [CommandName.FilesCopy]: ({ path }) => {
      main.copied?.push(path)
      return null
    },
    [CommandName.FilesReveal]: ({ path }) => {
      main.revealed?.push(path)
      return null
    },
    [CommandName.ArtifactsRemove]: ({ taskId, path }) => {
      const index = artifacts.findIndex((artifact) => artifact.taskId === taskId && artifact.path === path)
      if (index === -1) return refuse(bridgeError(BridgeErrorCode.NotFound, `No artifact ${path}`))
      artifacts.splice(index, 1)
      emit({
        type: EventType.ArtifactsChanged,
        taskId,
        artifacts: artifacts.filter((artifact) => artifact.taskId === taskId),
      })
      return null
    },
    [CommandName.ClipboardWriteText]: ({ text }) => {
      main.copied?.push(text)
      return null
    },
    [CommandName.UiStateGet]: ({ key }) => ({ value: main.uiState.find((entry) => entry.key === key)?.value ?? null }),
    [CommandName.UiStateGetAll]: () => ({ entries: [...main.uiState] }),
    [CommandName.UiStateSet]: (entry) => {
      const index = main.uiState.findIndex(({ key }) => key === entry.key)
      if (index === -1) main.uiState.push(entry)
      else main.uiState[index] = entry
      emit({ type: EventType.UiStateChanged, entry })
      return null
    },
    [CommandName.SearchQuery]: ({ workspaceId, text }) => ({ results: fakeSearch(main, workspaceId, text) }),
    [CommandName.TerminalList]: () => ({ tabs: [...terminalTabs] }),
    [CommandName.TerminalCreate]: ({ workspaceId }) => {
      const cwd = main.workspaces.find(({ id }) => id === workspaceId)?.rootPath ?? '/Users/sample'
      return addTerminal({ name: null, process: 'zsh', running: false, cwd }, terminalTabs.length)
    },
    [CommandName.TerminalDuplicate]: ({ id }) => {
      const { index, tab } = terminalAt(id)
      return addTerminal({ name: tab.name, process: 'zsh', running: false, cwd: tab.cwd }, index + 1)
    },
    [CommandName.TerminalAttach]: ({ id, cols, rows }) => {
      terminalCalls.push(`attach ${id} ${String(cols)}x${String(rows)}`)
      const output = main.terminalOutput?.[id] ?? ''
      return { output, end: output.length }
    },
    [CommandName.TerminalWrite]: ({ id, data }) => {
      terminalCalls.push(`write ${id} ${data}`)
      return null
    },
    [CommandName.TerminalResize]: ({ id, cols, rows }) => {
      terminalCalls.push(`resize ${id} ${String(cols)}x${String(rows)}`)
      return null
    },
    [CommandName.TerminalRename]: ({ id, name }) => {
      const { index, tab } = terminalAt(id)
      terminalTabs[index] = { ...tab, name }
      tabsChanged()
      return null
    },
    [CommandName.TerminalClear]: ({ id }) => {
      terminalCalls.push(`clear ${id}`)
      emit({ type: EventType.TerminalCleared, tabId: id })
      return null
    },
    [CommandName.TerminalInterrupt]: ({ id }) => {
      terminalCalls.push(`interrupt ${id}`)
      return null
    },
    [CommandName.TerminalClose]: ({ id }) => {
      terminalTabs.splice(terminalAt(id).index, 1)
      tabsChanged()
      return null
    },
  }
}

/**
 * A stand-in for main's search: the workspace's tasks, in list order, whose title, objective, status or a message
 * matches `highlightPattern(text)`, each with the whole first matching field (other than the title) as its snippet.
 */
function fakeSearch(main: FakeMain, workspaceId: string, text: string): SearchResult[] {
  const pattern = highlightPattern(text)
  if (pattern === null) return []
  const results: SearchResult[] = []
  for (const task of main.tasks) {
    if (task.workspaceId !== workspaceId) continue
    const fields: [SearchField, string][] = [
      [SearchField.Objective, task.objective],
      [SearchField.Status, task.status],
      ...(main.messages ?? [])
        .filter((message) => message.taskId === task.id)
        .map((message): [SearchField, string] => [SearchField.Message, message.body]),
      [SearchField.Title, task.title],
    ]
    for (const [field, body] of fields) {
      const snippet = highlightParts(body, pattern)
      if (snippet.some((part) => part.match)) {
        results.push({ taskId: task.id, field, snippet })
        break
      }
    }
  }
  return results
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

/** A terminal tab at its shell's prompt, starting in `/code/api`. */
export function sampleTerminalTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { id, name: null, process: 'zsh', running: false, cwd: '/Users/sample/code/api', ...overrides }
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
    statusUpdatedAt: null,
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
    contextUsedTokens: 0,
    contextWindowTokens: 200_000,
    error: null,
    retrying: null,
    asking: false,
    pause: null,
  }
}

export function sampleMessage(id: string, taskId: string, body = 'Add rate limiting to the public API.'): Message {
  return { id, taskId, role: MessageRole.User, body, turn: 1, createdAt: 3_000, summary: null }
}

export function sampleQueuedMessage(id: string, taskId: string, body = 'Keep the original filenames.'): QueuedMessage {
  return { id, taskId, body, createdAt: 4_000 }
}

/** An open question set: a choice and a text question. */
export function sampleQuestionSet(id: string, taskId: string): QuestionSet {
  return {
    id,
    taskId,
    turn: 1,
    questions: [
      {
        kind: QuestionKind.Choice,
        prompt: 'How should the notes be laid out?',
        options: [
          { id: 'by-type', label: 'By type' },
          { id: 'by-area', label: 'By area' },
        ],
      },
      { kind: QuestionKind.Text, prompt: 'Anything else?', optional: true },
    ],
    state: QuestionSetState.Open,
    reply: null,
    createdAt: 3_000,
    closedAt: null,
  }
}
