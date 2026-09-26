/**
 * Logs what main tells the windows (`GladeEvent`s), since every change that matters to a task goes through them: a
 * task's state and activity changing, its error and pause, the chat's messages, the tool log's calls, questions asked
 * and answered, permission requests opened and answered, the queue, todos, artifacts and handoff notes. Each line carries the task's id. Message text, tool input and output,
 * and questions go in at debug level, cut short (`excerpt`); the rest at info.
 *
 * A task update carries the whole task, so what changed is found against the task as it was last seen: the tasks as
 * the app started, then each update.
 */
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  PermissionRequestState,
  QuestionReplyKind,
  ToolCallState,
  ToolEventKind,
  type PermissionRequest,
  type QuestionReply,
  type QuestionSet,
  type Task,
  type ToolEvent,
} from '../../shared/domain'
import { permissionRuleString } from '../../shared/permissions'
import { excerpt } from './format'
import { LogScope, type LogFields, type Logger } from './logger'

/** The task's fields a change to which gets a line of its own. The others (context usage, unread…) are debug. */
type WatchedField = Extract<
  keyof Task,
  | 'state'
  | 'activity'
  | 'error'
  | 'pause'
  | 'retrying'
  | 'sessionId'
  | 'title'
  | 'model'
  | 'effort'
  | 'permissionMode'
  | 'asking'
  | 'awaitingPermission'
>

const WATCHED: readonly WatchedField[] = [
  'state',
  'activity',
  'error',
  'pause',
  'retrying',
  'sessionId',
  'title',
  'model',
  'effort',
  'permissionMode',
  'asking',
  'awaitingPermission',
]

/** A value as JSON, cut short: for a tool's input, or a question set. */
function jsonExcerpt(value: unknown): string {
  return excerpt(JSON.stringify(value))
}

/** The names of the fields that differ between two tasks. */
function changedFields(before: Task, after: Task): (keyof Task)[] {
  return (Object.keys(after) as (keyof Task)[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )
}

/** A reply's text as the log keeps it. */
function replyText(reply: QuestionReply | null): string {
  if (reply === null) return ''
  switch (reply.kind) {
    case QuestionReplyKind.Answers:
      return jsonExcerpt(reply.answers)
    case QuestionReplyKind.FreeText:
      return excerpt(reply.text)
  }
}

/** Creates the event log: call it with each event main emits, before it goes to the windows. */
export function createEventLog(log: Logger, tasks: readonly Task[]): (event: GladeEvent) => void {
  const known = new Map(tasks.map((task) => [task.id, task]))
  const taskLog = log.scoped(LogScope.Task)
  const chat = log.scoped(LogScope.Chat)
  const tools = log.scoped(LogScope.Tools)
  const questions = log.scoped(LogScope.Questions)
  const permissions = log.scoped(LogScope.Permissions)
  const terminal = log.scoped(LogScope.Terminal)
  const app = log.scoped(LogScope.App)

  const taskUpdated = (task: Task): void => {
    const before = known.get(task.id)
    known.set(task.id, task)
    const withTask = taskLog.with({ taskId: task.id })
    if (before === undefined) {
      const { workspaceId, state, activity, model, effort } = task
      withTask.info('task created', { workspaceId, state, activity, model, effort })
      return
    }
    const changed = changedFields(before, task)
    const watched = changed.filter((key): key is WatchedField => (WATCHED as readonly string[]).includes(key))
    for (const key of watched) taskChanged(withTask, key, before, task)
    if (watched.length === 0 && changed.length > 0) withTask.debug('task updated', { changed })
  }

  const taskChanged = (withTask: Logger, key: WatchedField, before: Task, task: Task): void => {
    switch (key) {
      case 'state':
        withTask.info('task state changed', { from: before.state, to: task.state })
        return
      case 'activity':
        withTask.info('task activity changed', { from: before.activity, to: task.activity })
        return
      case 'error':
        if (task.error === null) withTask.info('task error cleared')
        else withTask.warn('task error', { error: { ...task.error, details: excerpt(task.error.details) } })
        return
      case 'pause':
        if (task.pause === null) withTask.info('task pause cleared')
        else withTask.info('task paused', { pause: task.pause })
        return
      case 'retrying':
        if (task.retrying === null) withTask.info('task retry over')
        else withTask.info('task retrying', { retrying: task.retrying })
        return
      case 'asking':
        withTask.info(task.asking ? 'task asking' : 'task no longer asking')
        return
      case 'awaitingPermission':
        withTask.info(task.awaitingPermission ? 'task awaiting permission' : 'task no longer awaiting permission')
        return
      case 'sessionId':
      case 'title':
      case 'model':
      case 'effort':
      case 'permissionMode':
        withTask.info(`task ${key} changed`, { from: before[key], to: task[key] })
    }
  }

  const toolEvent = (event: ToolEvent, appended: boolean): void => {
    const withTask = tools.with({ taskId: event.taskId, turn: event.turn })
    switch (event.kind) {
      case ToolEventKind.ToolCall: {
        const { toolUseId, name, parentToolUseId, state } = event
        if (appended) {
          withTask.info('tool call started', { toolUseId, name, parentToolUseId })
          withTask.debug('tool call input', { toolUseId, input: jsonExcerpt(event.input) })
        }
        if (state === ToolCallState.Running) return
        const durationMs = event.finishedAt === null ? null : event.finishedAt - event.createdAt
        const fields: LogFields = { toolUseId, name, parentToolUseId, state, durationMs }
        if (state === ToolCallState.Error) withTask.warn('tool call finished', fields)
        else withTask.info('tool call finished', fields)
        withTask.debug('tool call output', { toolUseId, output: excerpt(event.output ?? '') })
        return
      }
      case ToolEventKind.Narration:
        withTask.debug('narration', { parentToolUseId: event.parentToolUseId, text: excerpt(event.text) })
        return
      case ToolEventKind.Divider:
        withTask.info('divider', { dividerKind: event.dividerKind })
        return
      case ToolEventKind.Compaction: {
        const { trigger, state, preTokens, postTokens, windowTokens } = event
        withTask.info(appended ? 'compaction started' : 'compaction finished', {
          trigger,
          state,
          preTokens,
          postTokens,
          windowTokens,
        })
        return
      }
    }
  }

  const questionSet = (message: string, set: QuestionSet): void => {
    const withTask = questions.with({ taskId: set.taskId, questionSetId: set.id, turn: set.turn })
    withTask.info(message, { count: set.questions.length, state: set.state })
    if (message === 'questions asked') withTask.debug('question text', { questions: jsonExcerpt(set.questions) })
    if (set.reply !== null) withTask.debug('question reply', { replyKind: set.reply.kind, reply: replyText(set.reply) })
  }

  const permissionRequest = (request: PermissionRequest): void => {
    const { id: permissionRequestId, taskId, turn, toolUseId, agentId, toolName, state } = request
    const withTask = permissions.with({ taskId, permissionRequestId, turn })
    switch (state) {
      case PermissionRequestState.Open:
        withTask.info('permission requested', { toolUseId, agentId, toolName })
        withTask.debug('permission input', { toolUseId, input: jsonExcerpt(request.input) })
        return
      case PermissionRequestState.Allowed:
        withTask.info('permission allowed', { toolUseId, toolName, forTask: request.grantedRule !== null })
        if (request.grantedRule !== null) {
          withTask.debug('permission rule granted', { rule: permissionRuleString(request.grantedRule) })
        }
        return
      case PermissionRequestState.Denied:
        withTask.info('permission denied', { toolUseId, toolName, withNote: request.denyNote !== null })
        if (request.denyNote !== null) withTask.debug('permission deny note', { note: excerpt(request.denyNote) })
        return
      case PermissionRequestState.Withdrawn:
        withTask.info('permission withdrawn', { toolUseId, toolName })
        return
    }
  }

  return (event) => {
    switch (event.type) {
      case EventType.TaskUpdated:
        taskUpdated(event.task)
        return
      case EventType.TaskDeleted:
        known.delete(event.taskId)
        taskLog.info('task deleted', { taskId: event.taskId })
        return
      case EventType.MessageAppended: {
        const { id: messageId, taskId, role, turn, body, summary, images } = event.message
        const withTask = chat.with({ taskId, messageId })
        withTask.info('message appended', { role, turn, chars: body.length, images: images.length, summary })
        withTask.debug('message text', { role, text: excerpt(body) })
        return
      }
      case EventType.QueueChanged:
        chat.info('queue changed', { taskId: event.taskId, queued: event.queuedMessages.length })
        for (const { id, body } of event.queuedMessages) {
          chat.debug('queued message', { taskId: event.taskId, queuedMessageId: id, text: excerpt(body) })
        }
        return
      case EventType.ToolEventAppended:
        toolEvent(event.toolEvent, true)
        return
      case EventType.ToolEventUpdated:
        toolEvent(event.toolEvent, false)
        return
      case EventType.QuestionOpened:
        questionSet('questions asked', event.questionSet)
        return
      case EventType.QuestionAnswered:
        questionSet('questions answered', event.questionSet)
        return
      case EventType.QuestionWithdrawn:
        questionSet('questions withdrawn', event.questionSet)
        return
      case EventType.PermissionOpened:
      case EventType.PermissionAnswered:
      case EventType.PermissionWithdrawn:
        permissionRequest(event.permissionRequest)
        return
      case EventType.TodosChanged:
        tools.info('todos changed', { taskId: event.taskId, todos: event.todos?.items.length ?? 0 })
        return
      case EventType.ArtifactsChanged:
        tools.info('artifacts changed', { taskId: event.taskId, artifacts: event.artifacts.length })
        return
      case EventType.HandoffChanged:
        tools.info(event.handoff === null ? 'handoff cleared' : 'handoff set', { taskId: event.taskId })
        return
      case EventType.WatchersChanged:
        tools.info('watchers changed', {
          taskId: event.taskId,
          watchers: event.watchers.map(({ kind, state, wakes }) => `${kind} ${state} ${String(wakes)}`),
        })
        return
      case EventType.FileShown:
        tools.info('file shown', { taskId: event.taskId, path: event.path, line: event.line })
        return
      case EventType.OpenFilesChanged: {
        const { taskId, paths, activePath } = event.openFiles
        tools.debug('open files changed', { taskId, open: paths.length, activePath })
        return
      }
      case EventType.TaskOpenRequested:
        app.info('task open requested', { taskId: event.taskId })
        return
      case EventType.WorkspaceUpdated: {
        const { id: workspaceId, name, rootPath } = event.workspace
        app.info('workspace updated', { workspaceId, name, rootPath })
        return
      }
      case EventType.WorkspaceRemoved:
        app.info('workspace removed', { workspaceId: event.workspaceId })
        return
      case EventType.SettingsChanged:
        app.info('settings changed', { settings: event.settings })
        return
      case EventType.ControlChanged:
        // The endpoint logs its own starting, stopping and failing, and never its token.
        return
      case EventType.AccountChanged:
        // The account logs its reads and warnings itself, and never the email or organization.
        return
      case EventType.MenuBarChanged:
        // Sent to the menu bar popover alone, never through here: what's in it is logged as the tasks change.
        return
      case EventType.PluginsChanged:
      case EventType.PluginStatusChanged:
        // The plugins log themselves as they're read and turned on or off, and their views as their statuses change.
        return
      case EventType.UiStateChanged:
        app.debug('ui state changed', { key: event.entry.key, value: excerpt(event.entry.value) })
        return
      case EventType.MenuCommand:
        app.debug('menu command', { command: event.command })
        return
      case EventType.TerminalTabsChanged:
        terminal.debug('terminal tabs changed', { tabs: event.tabs.length })
        return
      case EventType.TerminalCleared:
        terminal.debug('terminal cleared', { tabId: event.tabId })
        return
      case EventType.TerminalOutput:
        // Too much to log, and it's what the terminal shows, not what Glade did.
        return
    }
  }
}
