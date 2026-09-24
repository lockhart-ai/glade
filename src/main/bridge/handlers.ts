import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, CommandName, EventType, type CommandRequest, type CommandResponse } from '../../shared/bridge'
import type { AgentRunner } from '../agent/runner'
import { listArtifacts } from '../db/repositories/artifacts'
import { listMessages } from '../db/repositories/messages'
import { getOpenFiles } from '../db/repositories/open-files'
import { listQuestionSets } from '../db/repositories/question-sets'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, listTasks } from '../db/repositories/tasks'
import { listToolEvents } from '../db/repositories/tool-events'
import { getUiState, listUiState, setUiState } from '../db/repositories/ui-state'
import { listWorkspaces } from '../db/repositories/workspaces'
import { createWorkspaceAt, openWorkspace } from '../workspaces/workspaces'
import { editQueuedMessage, removeQueuedMessage } from '../tasks/queue'
import { noteUiStateSet } from '../tasks/attention'
import { createTask, markTaskDone, reopenTask, updateTaskFromUser } from '../tasks/service'
import {
  closeTaskFile,
  copyTaskFile,
  infoOfTaskFile,
  openTaskFile,
  openTaskFileInEditor,
  readTaskFile,
  revealTaskFile,
  type OpenPath,
  type RevealPath,
  type WriteClipboard,
} from '../files/files'
import { todoListFor } from '../todos/todos'
import { CommandFailure } from './errors'
import type { Emit } from './events'

/**
 * One handler per command, taking the parsed request. A command in `CommandMap` without a handler here, or a handler
 * whose request or response doesn't match the map, fails the typecheck.
 */
export type Handlers = {
  readonly [C in CommandName]: (request: CommandRequest<C>) => CommandResponse<C> | Promise<CommandResponse<C>>
}

export interface HandlerContext {
  readonly db: Database
  readonly emit: Emit
  /** Shows the native open-folder dialog; resolves with the chosen path, or null when cancelled. */
  readonly chooseFolder: () => Promise<string | null>
  readonly runner: AgentRunner
  /** Opens a file in the app macOS opens its kind of file with (Electron's `shell.openPath`). */
  readonly openPath: OpenPath
  /** Shows a file in Finder, selected (Electron's `shell.showItemInFolder`). */
  readonly revealPath: RevealPath
  /** Puts text on the clipboard (Electron's `clipboard.writeText`). */
  readonly writeClipboard: WriteClipboard
}

export function createHandlers(context: HandlerContext): Handlers {
  const { db, emit, chooseFolder, runner } = context
  return {
    [CommandName.WorkspacesList]: () => ({ workspaces: listWorkspaces(db) }),
    [CommandName.WorkspacesCreate]: ({ rootPath }) => {
      const creation = createWorkspaceAt(db, rootPath)
      if (creation.created) emit({ type: EventType.WorkspaceUpdated, workspace: creation.workspace })
      return creation
    },
    [CommandName.WorkspacesOpen]: ({ id }) => {
      const { workspace, uiState } = openWorkspace(db, id)
      emit({ type: EventType.WorkspaceUpdated, workspace })
      for (const entry of uiState) emit({ type: EventType.UiStateChanged, entry })
      return { workspace }
    },
    [CommandName.DialogChooseFolder]: async () => ({ path: await chooseFolder() }),
    [CommandName.TasksList]: ({ workspaceId }) => ({ tasks: listTasks(db, workspaceId) }),
    [CommandName.TasksCreate]: ({ workspaceId }) => ({ task: createTask(context, workspaceId) }),
    [CommandName.TasksMarkDone]: ({ id }) => ({ task: markTaskDone(context, id) }),
    [CommandName.TasksReopen]: ({ id }) => ({ task: reopenTask(context, id) }),
    [CommandName.TasksUpdate]: ({ id, patch }) => ({ task: updateTaskFromUser(context, id, patch) }),
    [CommandName.TasksSend]: ({ id, text }) => ({ message: runner.send(id, text) }),
    [CommandName.TasksStop]: async ({ id }) => ({ task: await runner.stop(id) }),
    [CommandName.TasksRetry]: ({ id, model }) => ({ task: runner.retry(id, model) }),
    [CommandName.TasksCompact]: ({ id }) => ({ task: runner.compact(id) }),
    [CommandName.TasksHistory]: ({ id }) => {
      if (getTask(db, id) === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${id}`)
      return {
        messages: listMessages(db, id),
        toolEvents: listToolEvents(db, id),
        queuedMessages: listQueuedMessages(db, id),
        questionSets: listQuestionSets(db, id),
        openFiles: getOpenFiles(db, id),
        todos: todoListFor(db, id),
        artifacts: listArtifacts(db, id),
      }
    },
    [CommandName.QueueAdd]: ({ taskId, text }) => ({ queuedMessage: runner.queue(taskId, text) }),
    [CommandName.QueueEdit]: ({ id, text }) => ({ queuedMessage: editQueuedMessage(context, id, text) }),
    [CommandName.QueueRemove]: ({ id }) => {
      removeQueuedMessage(context, id)
      return null
    },
    [CommandName.QuestionsAnswer]: ({ id, answers }) => ({ questionSet: runner.answer(id, answers) }),
    [CommandName.FilesRead]: async ({ taskId, path }) => ({ content: await readTaskFile(context, taskId, path) }),
    [CommandName.FilesOpen]: ({ taskId, path }) => ({ openFiles: openTaskFile(context, taskId, path) }),
    [CommandName.FilesClose]: ({ taskId, path }) => ({ openFiles: closeTaskFile(context, taskId, path) }),
    [CommandName.FilesOpenInEditor]: async ({ taskId, path }) => {
      await openTaskFileInEditor(context, taskId, path)
      return null
    },
    [CommandName.FilesInfo]: async ({ taskId, path }) => ({ info: await infoOfTaskFile(context, taskId, path) }),
    [CommandName.FilesCopy]: async ({ taskId, path }) => {
      await copyTaskFile(context, taskId, path)
      return null
    },
    [CommandName.FilesReveal]: async ({ taskId, path }) => {
      await revealTaskFile(context, taskId, path)
      return null
    },
    [CommandName.UiStateGet]: ({ key }) => ({ value: getUiState(db, key) ?? null }),
    [CommandName.UiStateGetAll]: () => ({ entries: listUiState(db) }),
    [CommandName.UiStateSet]: (entry) => {
      setUiState(db, entry)
      emit({ type: EventType.UiStateChanged, entry })
      noteUiStateSet(context, entry)
      return null
    },
  }
}
