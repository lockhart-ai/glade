// Test helpers: an in-memory stand-in for main behind `window.glade`, and made-up sample data.
import { vi } from 'vitest'
import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  type LogRendererErrorRequest,
  type PluginsPlaceViewRequest,
  EventType,
  type CommandRequest,
  type CommandResponse,
  type BridgeError,
  type EventListener,
  type GladeBridge,
  type GladeEvent,
} from '../../shared/bridge'
import type { MenuState } from '../../shared/commands'
import {
  Effort,
  PermissionMode,
  FileContentKind,
  FileInfoKind,
  MessageRole,
  PermissionDecisionKind,
  PermissionDestination,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  TaskState,
  LIVE_WATCHER_STATES,
  WatcherKind,
  WatcherState,
  type Artifact,
  type CommitFiles,
  type TaskCommit,
  type TaskHandoff,
  type FileContent,
  type FileInfo,
  type InputDraft,
  type Message,
  type OpenFiles,
  type PermissionRequest,
  type QuestionSet,
  type QueuedMessage,
  type Task,
  type TodoList,
  type ToolEvent,
  type UiStateEntry,
  type Watcher,
  type Workspace,
} from '../../shared/domain'
import { commitFileKey, noOpenFiles, withClosedFile, withOpenedFile } from '../../shared/files'
import { taskPermissionRule } from '../../shared/permissions'
import type { ImageData, ImageRef } from '../../shared/images'
import { BUILT_IN_MODELS, type ModelChoice } from '../../shared/models'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import { controlUrl, type ControlStatus } from '../../shared/control'
import type { AccountStatus } from '../../shared/account'
import { PluginStatus, type InstalledPlugin } from '../../shared/plugins'
import { highlightParts, highlightPattern, SearchField, type SearchResult } from '../../shared/search'
import type { TerminalTab } from '../../shared/terminal'
import { addDoneCounts, doneCountsOf, isInDoneSection, NO_DONE_TASKS, pageOfDone } from '../../shared/doneList'
import { EMPTY_MENU_BAR_SNAPSHOT, type MenuBarSnapshot } from '../../shared/menuBar'

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
  /**
   * Each task's stored input draft, by task id; none when left out. `drafts.set` changes them as main does: images left
   * out are kept, and an empty draft is removed.
   */
  readonly drafts?: Record<string, InputDraft>
  /** Every task's question sets; none when left out. `questions.answer` answers one, without checking the answers. */
  readonly questionSets?: QuestionSet[]
  /**
   * Every task's permission requests; none when left out. `permissions.answer` allows or denies an open one, refusing
   * one that isn't open, as main does.
   */
  readonly permissionRequests?: PermissionRequest[]
  /** Every task's open files; none when left out. `files.open` and `files.close` change them. */
  readonly openFiles?: OpenFiles[]
  /** What `files.read` answers with, by path, for any task; missing when left out. */
  readonly files?: Readonly<Record<string, FileContent>>
  /** The paths `files.openInEditor` opened, oldest first. */
  readonly openedInEditor?: string[]
  /** The subagents `subagents.stop` stopped, by their `Agent` calls' tool_use ids, oldest first. */
  readonly stoppedSubagents?: string[]
  /** Every task's watchers; `watchers.stop` stops one (as a job is stopped: at once) and records its id in `stoppedWatchers`. */
  readonly watchers?: Watcher[]
  /** The watchers `watchers.stop` was asked to stop, by id, in order. */
  readonly stoppedWatchers?: string[]
  /** Every task's commits, newest first; none when left out. */
  readonly commits?: TaskCommit[]
  /** What `changes.files` answers with, by commit id; a commit left out fails, as one its repository no longer has. */
  readonly commitFiles?: Readonly<Record<string, CommitFiles>>
  /**
   * The files that are still in the workspace, by `<commit id>:<path>`, with the path relative to the workspace root
   * that `changes.openFile` opens for each; any other opens as its commit left it (its commit file key).
   */
  readonly currentCommitFiles?: Readonly<Record<string, string>>
  /** Whether `changes.repository` says the workspace is in a git repository; it is when left out. */
  readonly inRepository?: boolean
  /** Each task's todo list, by task id; none when left out. */
  readonly todos?: Readonly<Record<string, TodoList>>
  /** Every task's artifacts; none when left out. `artifacts.remove` removes one, from the fake's own copy. */
  readonly artifacts?: readonly Artifact[]
  /** Each task's handoff note, by task id; none when left out. */
  readonly handoffs?: Readonly<Record<string, TaskHandoff>>
  /** What `files.info` answers with, by path, for any task; missing when left out. */
  readonly fileInfo?: Readonly<Record<string, FileInfo>>
  /** What was put on the clipboard, oldest first: the path of each file `files.copy` copied, and the text of each
   * `clipboard.writeText`. */
  readonly copied?: string[]
  /** The paths `files.reveal` revealed, oldest first. */
  readonly revealed?: string[]
  /** The settings `settings.get` starts answering with; the defaults when left out. `settings.update` changes them. */
  readonly settings?: Settings
  /** The models `models.list` answers with; the built-in ones when left out. */
  readonly models?: readonly ModelChoice[]
  /** What `account.status` answers with: no account read and no warning when left out. */
  readonly accountStatus?: AccountStatus
  /** The task last selected in each workspace, by workspace id, which `workspaces.open` selects; none when left out. */
  readonly workspaceSelections?: Readonly<Record<string, string>>
  /** The workspaces `workspaces.reveal` revealed, by id, oldest first. */
  readonly revealedWorkspaces?: string[]
  /**
   * The plugins `plugins.list` answers with, in order; none when left out. `plugins.setEnabled` turns a valid one on or
   * off, broadcasting them, and refuses any other with `not_found`.
   */
  plugins?: InstalledPlugin[]
  /** How many times `plugins.openFolder` opened the plugins folder. */
  openedPluginsFolder?: number
  /** Where `plugins.placeView` put each plugin's view, oldest first. */
  placedPluginViews?: PluginsPlaceViewRequest[]
  /** The status `plugins.placeView` answers with for each plugin, by id; `''` when left out. */
  pluginStatuses?: Record<string, string>
  /**
   * The port the control endpoint listens on while it's on, when the chosen one is taken; the chosen one when left out.
   * `control.status` answers as main would: listening while `controlEnabled` is on, with `token-1` from the first time
   * it goes on; `settings.update` of the switch or the port and `control.regenerateToken` (`token-2`, …) broadcast it.
   */
  readonly controlFallbackPort?: number
  /** Why the control endpoint can't listen while it's on (every port taken, say); none when left out. */
  readonly controlError?: string
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
  /** What the window told main the menu bar shows (`menu.update`), oldest first. */
  readonly menuStates?: MenuState[]
  /** How many times `window.close` closed the window. */
  closedWindows?: number
  /**
   * The stored images `images.get` answers with, by id; `tasks.send` and `queue.add` add each message's images here,
   * as `image-1`, `image-2`… None when left out.
   */
  readonly images?: Record<string, ImageData>
  /** The errors the window sent to the main log (`log.rendererError`), oldest first. */
  readonly rendererErrors?: LogRendererErrorRequest[]
  /** What `menuBar.get` answers with: nothing in flight when left out. */
  readonly menuBar?: MenuBarSnapshot
  /**
   * What the menu bar popover asked of main, oldest first, each as its name and arguments: `openTask t1`,
   * `openGlade`, `hide`, `quit`, `fit 320`. `menuBar.openTask` refuses a task that isn't there with `not_found`.
   */
  readonly menuBarCalls?: string[]
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
 * workspace, `workspaces.open` answers with it opened at 5,000 and `workspaces.update` changes it, none broadcasting.
 * `settings.update` changes the settings and broadcasts them.
 * workspace and `workspaces.open` answers with it opened at 5,000 and its selection from `workspaceSelections`, neither
 * broadcasting.
 */
export function fakeHandlers(main: FakeMain, emit: (event: GladeEvent) => void): FakeHandlers {
  let sent = 0
  let settings = main.settings ?? DEFAULT_SETTINGS
  let tokens = 0
  const controlStatus = (): ControlStatus => {
    if (settings.controlEnabled && tokens === 0) tokens = 1
    const listening = settings.controlEnabled && main.controlError === undefined
    const port = listening ? (main.controlFallbackPort ?? settings.controlPort) : null
    return {
      enabled: settings.controlEnabled,
      chosenPort: settings.controlPort,
      port,
      url: port === null ? null : controlUrl(port),
      token: tokens === 0 ? null : `token-${String(tokens)}`,
      error: settings.controlEnabled ? (main.controlError ?? null) : null,
    }
  }
  let queued = 0
  const images = main.images ?? {}
  let stored = 0
  const store = (added: readonly ImageData[] = []): ImageRef[] =>
    added.map((image) => {
      stored += 1
      const id = `image-${String(stored)}`
      images[id] = image
      return { id, mediaType: image.mediaType }
    })
  const queue = main.queuedMessages ?? []
  const drafts = main.drafts ?? {}
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
    // Like main, it forgets the workspace's tasks and broadcasts their deletion, then the workspace's removal; unlike
    // main, it leaves the UI state alone.
    [CommandName.WorkspacesRemove]: ({ id }) => {
      const index = main.workspaces.findIndex((workspace) => workspace.id === id)
      if (index === -1) return refuse(bridgeError(BridgeErrorCode.NotFound, `No workspace ${id}`))
      main.workspaces.splice(index, 1)
      for (const task of main.tasks.filter(({ workspaceId }) => workspaceId === id)) {
        main.tasks.splice(main.tasks.indexOf(task), 1)
        emit({ type: EventType.TaskDeleted, taskId: task.id })
      }
      emit({ type: EventType.WorkspaceRemoved, workspaceId: id })
      return null
    },
    [CommandName.WorkspacesUpdate]: ({ id, patch }) => {
      const index = main.workspaces.findIndex((workspace) => workspace.id === id)
      const current = main.workspaces[index]
      if (current === undefined) return refuse(bridgeError(BridgeErrorCode.NotFound, `No workspace ${id}`))
      const workspace = { ...current, ...patch }
      main.workspaces[index] = workspace
      return { workspace }
    },
    [CommandName.DialogChooseFolder]: () => ({ path: null }),
    [CommandName.TasksList]: ({ workspaceId }) => ({
      tasks: main.tasks.filter((task) => task.workspaceId === workspaceId),
    }),
    [CommandName.TasksListActive]: ({ workspaceId }) => {
      const tasks = main.tasks.filter((task) => task.workspaceId === workspaceId)
      return {
        tasks: tasks.filter((task) => !isInDoneSection(task)),
        done: tasks.map(doneCountsOf).reduce((sum, counts) => addDoneCounts(sum, counts), NO_DONE_TASKS),
      }
    },
    [CommandName.TasksListDone]: (request) => pageOfDone(main.tasks, request),
    [CommandName.TasksGet]: ({ ids }) => ({ tasks: main.tasks.filter((task) => ids.includes(task.id)) }),
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
    [CommandName.TasksSend]: ({ id, text, images: added }) => {
      sent += 1
      const message = { ...sampleMessage(`sent-${String(sent)}`, id, text), images: store(added) }
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
      permissionRequests: (main.permissionRequests ?? []).filter((request) => request.taskId === id),
      openFiles: openFilesOf(id),
      todos: main.todos?.[id] ?? null,
      artifacts: artifacts.filter((artifact) => artifact.taskId === id),
      handoff: main.handoffs?.[id] ?? null,
      watchers: (main.watchers ?? []).filter((watcher) => watcher.taskId === id),
      commits: (main.commits ?? []).filter((commit) => commit.taskId === id),
    }),
    [CommandName.QueueAdd]: ({ taskId, text, images: added }) => {
      queued += 1
      const queuedMessage = { ...sampleQueuedMessage(`queued-${String(queued)}`, taskId, text), images: store(added) }
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
    [CommandName.ImagesGet]: ({ id }) => {
      const image = images[id]
      return image === undefined ? refuse(bridgeError(BridgeErrorCode.NotFound, `No image ${id}`)) : { image }
    },
    [CommandName.DraftsGet]: ({ taskId }) => ({ draft: drafts[taskId] ?? null }),
    [CommandName.DraftsSet]: ({ taskId, text, images: given }) => {
      const draft = { text, images: given ?? drafts[taskId]?.images ?? [] }
      if (draft.text === '' && draft.images.length === 0) Reflect.deleteProperty(drafts, taskId)
      else drafts[taskId] = draft
      return null
    },
    [CommandName.PermissionsAnswer]: ({ id, decision }) => {
      const requests = main.permissionRequests ?? []
      const index = requests.findIndex((request) => request.id === id)
      const current = requests[index]
      if (current === undefined) return refuse(bridgeError(BridgeErrorCode.NotFound, `No permission request ${id}`))
      if (current.state !== PermissionRequestState.Open) {
        return refuse(bridgeError(BridgeErrorCode.InvalidTransition, `Permission request ${id} isn't open`))
      }
      const denied = decision.kind === PermissionDecisionKind.Deny
      const grantedRule = decision.kind === PermissionDecisionKind.AllowForTask ? taskPermissionRule(current) : null
      if (decision.kind === PermissionDecisionKind.AllowForTask && grantedRule === null) {
        return refuse(
          bridgeError(BridgeErrorCode.InvalidRequest, `Permission request ${id} can't be allowed for the task`),
        )
      }
      const permissionRequest: PermissionRequest = {
        ...current,
        state: denied ? PermissionRequestState.Denied : PermissionRequestState.Allowed,
        denyNote: denied ? (decision.note ?? null) : null,
        grantedRule,
        closedAt: 3_000,
      }
      requests[index] = permissionRequest
      emit({ type: EventType.PermissionAnswered, permissionRequest })
      return { permissionRequest }
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
    [CommandName.WatchersListLive]: () => ({
      watchers: (main.watchers ?? []).filter(({ state }) => LIVE_WATCHER_STATES.includes(state)),
    }),
    [CommandName.WatchersStop]: ({ taskId, id }) => {
      main.stoppedWatchers?.push(id)
      const watchers = main.watchers ?? []
      const index = watchers.findIndex((watcher) => watcher.id === id)
      const watcher = watchers[index]
      if (watcher !== undefined) {
        watchers[index] = { ...watcher, state: WatcherState.Stopped, outcome: 'You stopped it.', nextDueAt: null }
        emit({ type: EventType.WatchersChanged, taskId, watchers: watchers.filter((w) => w.taskId === taskId) })
      }
      return null
    },
    [CommandName.ChangesFiles]: ({ id }) => {
      const files = main.commitFiles?.[id]
      return files === undefined
        ? refuse(bridgeError(BridgeErrorCode.Internal, `Couldn't read the files of commit ${id}`))
        : { files }
    },
    [CommandName.ChangesOpenFile]: ({ taskId, id, path }) =>
      changeOpenFiles(taskId, (open) =>
        withOpenedFile(open, main.currentCommitFiles?.[`${id}:${path}`] ?? commitFileKey({ commitId: id, path })),
      ),
    [CommandName.ChangesRepository]: () => ({ repository: main.inRepository ?? true }),
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
    [CommandName.SettingsGet]: () => ({ settings }),
    [CommandName.ModelsList]: () => ({ models: main.models ?? BUILT_IN_MODELS }),
    [CommandName.SettingsUpdate]: ({ patch }) => {
      settings = { ...settings, ...patch }
      emit({ type: EventType.SettingsChanged, settings })
      if (patch.controlEnabled !== undefined || patch.controlPort !== undefined) {
        emit({ type: EventType.ControlChanged, status: controlStatus() })
      }
      return { settings }
    },
    [CommandName.ControlStatus]: () => ({ status: controlStatus() }),
    [CommandName.AccountStatus]: () => ({ status: main.accountStatus ?? { account: null, usageWarning: null } }),
    [CommandName.ControlRegenerateToken]: () => {
      tokens += 1
      const status = controlStatus()
      emit({ type: EventType.ControlChanged, status })
      return { status }
    },
    [CommandName.SearchQuery]: ({ workspaceId, text }) => ({ results: fakeSearch(main, workspaceId, text) }),
    [CommandName.PluginsList]: () => ({ plugins: [...(main.plugins ?? [])] }),
    [CommandName.PluginsSetEnabled]: ({ id, enabled }) => {
      const plugins = main.plugins ?? []
      if (!plugins.some((plugin) => plugin.folder === id && plugin.status === PluginStatus.Valid)) {
        return refuse(bridgeError(BridgeErrorCode.NotFound, `No plugin ${id}`))
      }
      main.plugins = plugins.map((plugin) =>
        plugin.folder === id && plugin.status === PluginStatus.Valid ? { ...plugin, enabled } : plugin,
      )
      emit({ type: EventType.PluginsChanged, plugins: [...main.plugins] })
      return { plugins: [...main.plugins] }
    },
    [CommandName.PluginsOpenFolder]: () => {
      main.openedPluginsFolder = (main.openedPluginsFolder ?? 0) + 1
      return null
    },
    [CommandName.PluginsPlaceView]: (request) => {
      const plugin = main.plugins?.find(({ folder }) => folder === request.id)
      if (plugin?.status !== PluginStatus.Valid || !plugin.enabled) {
        return refuse(bridgeError(BridgeErrorCode.NotFound, `No plugin ${request.id}`))
      }
      main.placedPluginViews = [...(main.placedPluginViews ?? []), request]
      return { status: main.pluginStatuses?.[request.id] ?? '' }
    },
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
    [CommandName.MenuUpdate]: (state) => {
      main.menuStates?.push(state)
      return null
    },
    [CommandName.WindowClose]: () => {
      main.closedWindows = (main.closedWindows ?? 0) + 1
      return null
    },
    [CommandName.LogRendererError]: (error) => {
      main.rendererErrors?.push(error)
      return null
    },
    [CommandName.MenuBarGet]: () => ({ snapshot: main.menuBar ?? EMPTY_MENU_BAR_SNAPSHOT }),
    [CommandName.MenuBarOpenTask]: ({ id }) => {
      if (!main.tasks.some((task) => task.id === id))
        return refuse(bridgeError(BridgeErrorCode.NotFound, `No task ${id}`))
      main.menuBarCalls?.push(`openTask ${id}`)
      return null
    },
    [CommandName.MenuBarOpenGlade]: () => {
      main.menuBarCalls?.push('openGlade')
      return null
    },
    [CommandName.MenuBarHide]: () => {
      main.menuBarCalls?.push('hide')
      return null
    },
    [CommandName.MenuBarQuit]: () => {
      main.menuBarCalls?.push('quit')
      return null
    },
    [CommandName.MenuBarFit]: ({ height }) => {
      main.menuBarCalls?.push(`fit ${String(height)}`)
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
    permissionMode: PermissionMode.AllowAll,
    createdAt: 2_000,
    updatedAt: 2_000,
    doneAt: null,
    sessionId: null,
    contextUsedTokens: 0,
    contextWindowTokens: 200_000,
    error: null,
    retrying: null,
    asking: false,
    awaitingPermission: false,
    pause: null,
    importedAt: null,
    todos: null,
  }
}

/** A running `Monitor` on a PR's CI checks, started at 13:02 on 25 September 2026, unless `overrides` say otherwise. */
/**
 * A commit fixing the UTC date test on `fix/date-test`, made by the task's own agent at 13:02 on 25 September 2026,
 * unless `overrides` say otherwise. Its hash is its id's, repeated.
 */
export function sampleCommit(id: string, taskId: string, overrides: Partial<TaskCommit> = {}): TaskCommit {
  return {
    id,
    taskId,
    hash: `${id}0123456789abcdef`.padEnd(40, '0').slice(0, 40),
    subject: 'Fix the UTC date test',
    branch: 'fix/date-test',
    committedAt: new Date(2026, 8, 25, 13, 2).getTime(),
    additions: 12,
    deletions: 3,
    filesChanged: 2,
    merge: false,
    repoPath: '/code/acme-api',
    subagentToolUseId: null,
    ...overrides,
  }
}

export function sampleWatcher(id: string, taskId: string, overrides: Partial<Watcher> = {}): Watcher {
  return {
    id,
    taskId,
    kind: WatcherKind.Monitor,
    toolUseId: `toolu-${id}`,
    label: 'CI checks on PR #42',
    detail: 'gh pr checks 42 --watch',
    schedule: null,
    recurring: true,
    state: WatcherState.Running,
    wakes: 0,
    lastWokeAt: null,
    lastOutput: null,
    nextDueAt: null,
    expiresAt: null,
    outcome: null,
    startedAt: new Date(2026, 8, 25, 13, 2).getTime(),
    endedAt: null,
    ...overrides,
  }
}

export function sampleMessage(id: string, taskId: string, body = 'Add rate limiting to the public API.'): Message {
  return { id, taskId, role: MessageRole.User, body, turn: 1, createdAt: 3_000, summary: null, images: [] }
}

export function sampleQueuedMessage(id: string, taskId: string, body = 'Keep the original filenames.'): QueuedMessage {
  return { id, taskId, body, createdAt: 4_000, images: [] }
}

/** An open question set: a choice and a text question. */
/** An open permission request for the agent's own `Bash` call, `npm test`, which suggests the rule `npm test *`. */
export function samplePermissionRequest(id: string, taskId: string): PermissionRequest {
  return {
    id,
    taskId,
    turn: 1,
    toolUseId: `toolu-${id}`,
    agentId: null,
    toolName: 'Bash',
    input: { command: 'npm test', description: 'Run the test suite' },
    title: null,
    displayName: 'Bash',
    description: 'Run the test suite',
    suggestions: [
      {
        type: PermissionUpdateType.AddRules,
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        behavior: PermissionRuleBehavior.Allow,
        destination: PermissionDestination.LocalSettings,
      },
    ],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    state: PermissionRequestState.Open,
    denyNote: null,
    grantedRule: null,
    createdAt: 3_000,
    closedAt: null,
  }
}

export function sampleQuestionSet(id: string, taskId: string): QuestionSet {
  return {
    id,
    taskId,
    turn: 1,
    preamble: null,
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
