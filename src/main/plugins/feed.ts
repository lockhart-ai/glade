/**
 * The task and agent events plugins are fed (`docs/plugin-api.md`, "Events"). The feed watches what main tells the
 * windows (every `GladeEvent` goes through `observe`, as the event log does) and turns the few kinds a plugin may know
 * about into plugin events, through the allow-list in `./mapping`. Every other kind of event is dropped: chat messages,
 * the queue, todos, files, artifacts, the terminal, settings.
 *
 * **Subscribing** (a plugin's `ready`) reads a snapshot from SQLite: every active task in every workspace, their running
 * subagents, and their open questions and permission requests. Then each change follows, in order.
 *
 * **Nothing lost, nothing twice.** The snapshot is read in one go on main's thread, where every event is emitted, so
 * normally no event can land while it's read. Should one (an event emitted from inside a read), it's held until the
 * snapshot is sent, then applied against it: the feed keeps what it last told each subscriber of each task, subagent,
 * question set and permission request, and sends a change only when that differs.
 */
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  ToolCallState,
  ToolEventKind,
  type PermissionRequest,
  type QuestionSet,
  type Task,
  type ToolCallEvent,
  type ToolEvent,
  type Workspace,
} from '../../shared/domain'
import {
  PluginEventType,
  PluginSubagentState,
  type PluginChangeEvent,
  type PluginPermissionRequest,
  type PluginSnapshotEvent,
  type PluginSubagent,
  type PluginTask,
} from '../../shared/plugin-api'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import {
  cutText,
  latestLine,
  permissionOutcome,
  pluginPermissionRequest,
  pluginQuestion,
  pluginSubagent,
  pluginTask,
  pluginToolCall,
  questionOutcome,
  startsSubagent,
} from './mapping'

/** Where the feed reads its snapshot from: SQLite in the app (`databaseFeedSource`). */
export interface PluginFeedSource {
  /** Every workspace. */
  workspaces(): readonly Workspace[]
  /** Every active task, in every workspace. */
  activeTasks(): readonly Task[]
  /** A task's tool log, oldest first. */
  toolEvents(taskId: string): readonly ToolEvent[]
  /** Every open question set, in every task. */
  openQuestionSets(): readonly QuestionSet[]
  /** A task's open permission requests. */
  openPermissionRequests(taskId: string): readonly PermissionRequest[]
}

/** Where a subscriber's events go: the plugin's view, which wraps each in its envelope. */
export type PluginSink = (event: PluginSnapshotEvent | PluginChangeEvent) => void

/** Stops a subscriber's events. */
export type Unsubscribe = () => void

export interface PluginFeed {
  /** Takes in an event main emits. Call it with every one, before it goes to the windows. */
  observe(event: GladeEvent): void
  /** Sends `sink` a snapshot now, then each change, until it's unsubscribed. */
  subscribe(sink: PluginSink): Unsubscribe
}

export interface PluginFeedOptions {
  readonly source: PluginFeedSource
  /** Every task as the app starts, in every workspace, active or done: what's a new task and what's a change. */
  readonly tasks: readonly Task[]
  readonly log?: Logger
}

/** What one subscriber has been told, beyond the tasks (which every subscriber is told alike). */
interface Subscriber {
  readonly sink: PluginSink
  /** The subagents it knows of, by id, as it was last told them. */
  readonly subagents: Map<string, PluginSubagent>
  /** The open question sets it knows of: their task, by set id. */
  readonly questions: Map<string, string>
  /** The open permission requests it knows of: their task, by request id. */
  readonly permissions: Map<string, string>
}

/** A task's subagents from its tool log, each with its latest line, and the subagent each call in it was made in. */
interface TaskSubagents {
  readonly subagents: readonly PluginSubagent[]
  /** The subagent of each call made inside one, by the call's tool_use id. */
  readonly parents: ReadonlyMap<string, string>
}

/**
 * Whether a task changed in a way a plugin sees. `updatedAt` alone doesn't count: every write to a task stamps it (its
 * session starting, its context filling), and a plugin needn't hear of those. It goes along with the next change.
 */
function taskChanged(before: PluginTask, after: PluginTask): boolean {
  return JSON.stringify({ ...before, updatedAt: 0 }) !== JSON.stringify({ ...after, updatedAt: 0 })
}

export function createPluginFeed({ source, tasks: initial, log = SILENT_LOGGER }: PluginFeedOptions): PluginFeed {
  /** Every workspace's name and root, by id. */
  const workspaces = new Map<string, Workspace>(source.workspaces().map((workspace) => [workspace.id, workspace]))
  /** Every task, as a plugin sees it: what's sent is what differs from this. */
  const tasks = new Map<string, PluginTask>()
  /** The subagent each call made inside one belongs to, by the call's tool_use id: for its permission requests. */
  const parents = new Map<string, string>()
  const subscribers = new Set<Subscriber>()
  /** Events that arrived while a snapshot was read, to apply once it's sent. */
  let held: GladeEvent[] | null = null

  const workspaceOf = (workspaceId: string): Workspace | undefined => {
    const known = workspaces.get(workspaceId)
    if (known !== undefined) return known
    for (const workspace of source.workspaces()) workspaces.set(workspace.id, workspace)
    return workspaces.get(workspaceId)
  }
  const project = (task: Task): PluginTask => pluginTask(task, workspaceOf(task.workspaceId)?.name ?? '')
  const rootOf = (taskId: string): string | undefined => {
    const task = tasks.get(taskId)
    return task === undefined ? undefined : workspaces.get(task.workspaceId)?.rootPath
  }

  for (const task of initial) tasks.set(task.id, project(task))

  const broadcast = (event: PluginChangeEvent): void => {
    for (const subscriber of subscribers) subscriber.sink(event)
  }

  const taskUpdated = (task: Task): void => {
    const before = tasks.get(task.id)
    const after = project(task)
    tasks.set(task.id, after)
    if (before === undefined) broadcast({ type: PluginEventType.TaskCreated, task: after })
    else if (taskChanged(before, after)) broadcast({ type: PluginEventType.TaskUpdated, task: after })
  }

  const taskDeleted = (taskId: string): void => {
    tasks.delete(taskId)
    for (const subscriber of subscribers) {
      for (const [id, subagent] of subscriber.subagents) if (subagent.taskId === taskId) subscriber.subagents.delete(id)
      for (const [id, owner] of subscriber.questions) if (owner === taskId) subscriber.questions.delete(id)
      for (const [id, owner] of subscriber.permissions) if (owner === taskId) subscriber.permissions.delete(id)
    }
    broadcast({ type: PluginEventType.TaskDeleted, taskId })
  }

  const workspaceUpdated = (workspace: Workspace): void => {
    const before = workspaces.get(workspace.id)
    workspaces.set(workspace.id, workspace)
    if (before === undefined || before.name === workspace.name) return
    for (const task of [...tasks.values()]) {
      if (task.workspaceId !== workspace.id) continue
      const renamed = { ...task, workspaceName: cutText(workspace.name) }
      tasks.set(task.id, renamed)
      broadcast({ type: PluginEventType.TaskUpdated, task: renamed })
    }
  }

  /** Tells a subscriber of a subagent: started when it's new to them, updated when it differs from what they know. */
  /**
   * Tells a subscriber a subagent changed, when it differs from what they know. It's kept while it runs, for its latest
   * line, and forgotten once it ends.
   */
  const subagentUpdated = (subscriber: Subscriber, subagent: PluginSubagent): void => {
    const known = subscriber.subagents.get(subagent.id)
    if (subagent.state === PluginSubagentState.Running) subscriber.subagents.set(subagent.id, subagent)
    else subscriber.subagents.delete(subagent.id)
    if (known === undefined || JSON.stringify(known) !== JSON.stringify(subagent)) {
      subscriber.sink({ type: PluginEventType.SubagentUpdated, subagent })
    }
  }

  /** A subagent's call or note: its latest line changes, for the subscribers that know it. */
  const latestChanged = (parentId: string, line: string): void => {
    for (const subscriber of subscribers) {
      const known = subscriber.subagents.get(parentId)
      if (known !== undefined) subagentUpdated(subscriber, { ...known, latest: line })
    }
  }

  /** An `Agent` call started or changed: its subagent, for each subscriber. */
  const subagentCall = (call: ToolCallEvent, appended: boolean): void => {
    for (const subscriber of subscribers) {
      const known = subscriber.subagents.get(call.toolUseId)
      const subagent = pluginSubagent(call, known?.latest ?? null)
      if (!appended) subagentUpdated(subscriber, subagent)
      else if (known === undefined) {
        subscriber.subagents.set(subagent.id, subagent)
        subscriber.sink({ type: PluginEventType.SubagentStarted, subagent })
      }
    }
  }

  const toolCall = (call: ToolCallEvent, appended: boolean): void => {
    // A call changes while it runs only when its subagent says what it's doing now, which plugins aren't told.
    if (!appended && call.state === ToolCallState.Running) return
    const root = rootOf(call.taskId)
    if (appended && call.parentToolUseId !== null) {
      parents.set(call.toolUseId, call.parentToolUseId)
      latestChanged(call.parentToolUseId, latestLine(call, root))
    }
    // A permission request waits on a running call only.
    if (call.state !== ToolCallState.Running) parents.delete(call.toolUseId)
    broadcast({ type: PluginEventType.AgentToolCall, call: pluginToolCall(call, root) })
    if (startsSubagent(call)) subagentCall(call, appended)
  }

  const toolEvent = (event: ToolEvent, appended: boolean): void => {
    switch (event.kind) {
      case ToolEventKind.ToolCall:
        toolCall(event, appended)
        return
      case ToolEventKind.Narration: {
        const note = latestLine(event, undefined)
        if (!appended || note === '') return
        const { taskId, parentToolUseId: subagentId, createdAt: at } = event
        broadcast({ type: PluginEventType.AgentNote, taskId, subagentId, text: note, at })
        if (subagentId !== null) latestChanged(subagentId, note)
        return
      }
      // Dividers and compactions are the tool log's own bookkeeping.
      case ToolEventKind.Divider:
      case ToolEventKind.Compaction:
        return
    }
  }

  const questionSet = (set: QuestionSet): void => {
    const outcome = questionOutcome(set.state)
    for (const subscriber of subscribers) {
      if (outcome === null) {
        if (subscriber.questions.has(set.id)) continue
        subscriber.questions.set(set.id, set.taskId)
        subscriber.sink({ type: PluginEventType.QuestionOpened, question: pluginQuestion(set) })
      } else if (subscriber.questions.delete(set.id)) {
        subscriber.sink({ type: PluginEventType.QuestionClosed, taskId: set.taskId, questionSetId: set.id, outcome })
      }
    }
  }

  const subagentOf = (request: PermissionRequest): string | null =>
    request.agentId === null ? null : (parents.get(request.toolUseId) ?? null)

  const permissionRequest = (request: PermissionRequest): void => {
    const outcome = permissionOutcome(request.state)
    for (const subscriber of subscribers) {
      if (outcome === null) {
        if (subscriber.permissions.has(request.id)) continue
        subscriber.permissions.set(request.id, request.taskId)
        const opened = pluginPermissionRequest(request, subagentOf(request), rootOf(request.taskId))
        subscriber.sink({ type: PluginEventType.PermissionOpened, request: opened })
      } else if (subscriber.permissions.delete(request.id)) {
        const { taskId, id: requestId } = request
        subscriber.sink({ type: PluginEventType.PermissionClosed, taskId, requestId, outcome })
      }
    }
  }

  const apply = (event: GladeEvent): void => {
    switch (event.type) {
      case EventType.TaskUpdated:
        taskUpdated(event.task)
        return
      case EventType.TaskDeleted:
        taskDeleted(event.taskId)
        return
      case EventType.WorkspaceUpdated:
        workspaceUpdated(event.workspace)
        return
      case EventType.ToolEventAppended:
        toolEvent(event.toolEvent, true)
        return
      case EventType.ToolEventUpdated:
        toolEvent(event.toolEvent, false)
        return
      case EventType.QuestionOpened:
      case EventType.QuestionAnswered:
      case EventType.QuestionWithdrawn:
        questionSet(event.questionSet)
        return
      case EventType.PermissionOpened:
      case EventType.PermissionAnswered:
      case EventType.PermissionWithdrawn:
        permissionRequest(event.permissionRequest)
        return
      // Not a plugin's business: what's said in the chat and queued for it, the Files, Todos, Artifacts, Watchers and
      // Changes tabs, the handoff note, the terminal, the window's own state, settings, the models the pickers offer,
      // plugins and the control endpoint (whose token no plugin may see). A removed workspace's tasks are deleted one by one.
      case EventType.WorkspaceRemoved:
      case EventType.MessageAppended:
      case EventType.QueueChanged:
      case EventType.TodosChanged:
      case EventType.ArtifactsChanged:
      case EventType.HandoffChanged:
      case EventType.WatchersChanged:
      case EventType.CommitsChanged:
      case EventType.FileShown:
      case EventType.OpenFilesChanged:
      case EventType.TaskOpenRequested:
      case EventType.UiStateChanged:
      case EventType.MenuCommand:
      case EventType.SettingsChanged:
      case EventType.ModelsChanged:
      case EventType.PluginsChanged:
      case EventType.PluginStatusChanged:
      case EventType.ControlChanged:
      case EventType.AccountChanged:
      case EventType.MenuBarChanged:
      case EventType.TerminalTabsChanged:
      case EventType.TerminalCleared:
      case EventType.TerminalOutput:
        return
    }
  }

  /** A task's subagents and who made each call, from its tool log. */
  const taskSubagents = (taskId: string, root: string | undefined): TaskSubagents => {
    const found = new Map<string, PluginSubagent>()
    const made = new Map<string, string>()
    for (const event of source.toolEvents(taskId)) {
      if (event.kind !== ToolEventKind.ToolCall && event.kind !== ToolEventKind.Narration) continue
      const parent = event.parentToolUseId === null ? undefined : found.get(event.parentToolUseId)
      if (parent !== undefined) found.set(parent.id, { ...parent, latest: latestLine(event, root) })
      if (event.kind !== ToolEventKind.ToolCall) continue
      if (event.parentToolUseId !== null && event.state === ToolCallState.Running) {
        made.set(event.toolUseId, event.parentToolUseId)
      }
      if (startsSubagent(event)) found.set(event.toolUseId, pluginSubagent(event, null))
    }
    return { subagents: [...found.values()], parents: made }
  }

  const snapshot = (subscriber: Subscriber): PluginSnapshotEvent => {
    for (const workspace of source.workspaces()) workspaces.set(workspace.id, workspace)
    const active = source.activeTasks()
    const running: PluginSubagent[] = []
    const permissions: PluginPermissionRequest[] = []
    for (const task of active) {
      tasks.set(task.id, project(task))
      const root = rootOf(task.id)
      const found = taskSubagents(task.id, root)
      for (const [call, parent] of found.parents) parents.set(call, parent)
      for (const subagent of found.subagents) {
        if (subagent.state !== PluginSubagentState.Running) continue
        subscriber.subagents.set(subagent.id, subagent)
        running.push(subagent)
      }
      for (const request of source.openPermissionRequests(task.id)) {
        subscriber.permissions.set(request.id, request.taskId)
        permissions.push(pluginPermissionRequest(request, subagentOf(request), root))
      }
    }
    const activeIds = new Set(active.map((task) => task.id))
    const questions = source.openQuestionSets().filter((set) => activeIds.has(set.taskId))
    for (const set of questions) subscriber.questions.set(set.id, set.taskId)
    return {
      type: PluginEventType.Snapshot,
      tasks: active.map((task) => tasks.get(task.id) ?? project(task)),
      subagents: running,
      questions: questions.map(pluginQuestion),
      permissions,
    }
  }

  return {
    observe(event) {
      if (held !== null) {
        held.push(event)
        return
      }
      apply(event)
    },
    subscribe(sink) {
      const subscriber: Subscriber = { sink, subagents: new Map(), questions: new Map(), permissions: new Map() }
      const pending: GladeEvent[] = []
      held = pending
      let first: PluginSnapshotEvent | undefined
      try {
        first = snapshot(subscriber)
      } finally {
        held = null
        if (first !== undefined) {
          sink(first)
          subscribers.add(subscriber)
          log.debug('plugin feed subscribed', { tasks: first.tasks.length, held: pending.length })
        }
        // What happened while the snapshot was read still reaches everyone else, even if it couldn't be read.
        for (const event of pending) apply(event)
      }
      return () => {
        subscribers.delete(subscriber)
      }
    },
  }
}
