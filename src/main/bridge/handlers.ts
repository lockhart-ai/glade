import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, CommandName, EventType, type CommandRequest, type CommandResponse } from '../../shared/bridge'
import type { MenuState } from '../../shared/commands'
import type { AgentRunner } from '../agent/runner'
import { listArtifacts } from '../db/repositories/artifacts'
import { setArtifactGroupOpen, listArtifactGroups } from '../db/repositories/artifact-groups'
import { listLiveWatchers, listWatchers, publicWatcher } from '../db/repositories/watchers'
import { listTaskCommits } from '../db/repositories/task-commits'
import { commitFiles, openCommitFile, readCommitFile, workspaceInRepository } from '../changes/changes'
import { createGit, type Git } from '../git/git'
import { getHandoff } from '../db/repositories/backfills'
import { getImage } from '../db/repositories/images'
import { getInputDraft, setInputDraft } from '../db/repositories/input-drafts'
import { listMessages } from '../db/repositories/messages'
import { getOpenFiles } from '../db/repositories/open-files'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { listQuestionSets } from '../db/repositories/question-sets'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { searchTasks } from '../db/repositories/search'
import { countDoneTasks, getTasks, listActiveTasks, listDoneTasks, listTasks } from '../db/repositories/tasks'
import { listToolEvents } from '../db/repositories/tool-events'
import { getUiState, listUiState, setUiState } from '../db/repositories/ui-state'
import { getSettings, updateSettings } from '../db/repositories/settings'
import { effortWithModel, listModels } from '../models/models'
import { getWorkspace, listWorkspaces } from '../db/repositories/workspaces'
import type { Plugins } from '../plugins/plugins'
import type { PluginViews } from '../plugins/views'
import type { Terminals } from '../terminal/terminals'
import {
  changeWorkspace,
  createWorkspaceAt,
  noteSelection,
  openWorkspace,
  removeWorkspace,
} from '../workspaces/workspaces'
import { editQueuedMessage, removeQueuedMessage } from '../tasks/queue'
import { noteUiStateSet } from '../tasks/attention'
import { changeTask, createTask, deleteTask, markTaskDone, reopenTask, requireTask } from '../tasks/service'
import {
  closeTaskFile,
  copyTaskFile,
  thumbnailOfTaskFile,
  openTaskFile,
  openTaskFileInEditor,
  readTaskFile,
  revealTaskFile,
  type OpenPath,
  type RevealPath,
  type WriteClipboard,
} from '../files/files'
import { todoListFor } from '../todos/todos'
import { removeTaskArtifact } from '../artifacts/artifacts'
import { NO_THUMBNAILS, type Thumbnails } from '../artifacts/thumbnails'
import type { ArtifactWatcher } from '../artifacts/artifact-watch'
import { parseCommitFileKey } from '../../shared/files'
import { SILENT_LOGGER, LogScope, type Logger } from '../logging/logger'
import { CommandFailure } from './errors'
import type { Emit } from './events'
import type { ControlEndpoint } from '../control/endpoint'
import type { AccountTracker } from '../account/account'
import type { MenuBarCommands } from '../menu-bar/menu-bar'
import { readMenuBarSnapshot } from '../menu-bar/snapshot'

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
  /** Rebuilds the menu bar from what the window says it shows (`menu.update`). Nothing by default. */
  readonly updateMenu?: (state: MenuState) => void
  /** Closes the focused window (`window.close`). Nothing by default. */
  readonly closeWindow?: () => void
  /** The global terminal's tabs and their shells. */
  readonly terminals: Terminals
  /** The plugins in the plugins folder. */
  readonly plugins: Plugins
  /** The shown plugin's view. */
  readonly pluginViews: PluginViews
  /** The control API's HTTP endpoint, which follows Settings › Control. */
  readonly endpoint: ControlEndpoint
  /** The account the tasks run on and its usage warning. */
  readonly account: AccountTracker
  /** What the menu bar popover's page asks of main (`menuBar.*`). Nothing by default: no popover, nothing to do. */
  readonly menuBar?: MenuBarCommands
  /** Where errors in the window are logged (`log.rendererError`). Nothing by default. */
  readonly log?: Logger
  /** Reads git, for the Changes tab. The `git` on the PATH by default. */
  readonly git?: Git
  /** Makes and keeps the artifacts' thumbnails (`files.thumbnail`). None by default: every file shows its type. */
  readonly thumbnails?: Thumbnails
  /** Watches the files of the artifacts the Artifacts tab shows (`artifacts.watch`). None by default: nothing is. */
  readonly artifactWatch?: ArtifactWatcher
}

/** The root of the workspace a new terminal tab starts in, or null for none. */
function terminalRoot(db: Database, workspaceId: string | null): string | null {
  if (workspaceId === null) return null
  const workspace = getWorkspace(db, workspaceId)
  if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${workspaceId}`)
  return workspace.rootPath
}

export function createHandlers(context: HandlerContext): Handlers {
  const { db, emit, chooseFolder, runner, writeClipboard, terminals, plugins, pluginViews, endpoint, account } = context
  const renderer = (context.log ?? SILENT_LOGGER).scoped(LogScope.Renderer)
  const changes = { db, emit, git: context.git ?? createGit() }
  return {
    [CommandName.WorkspacesList]: () => ({ workspaces: listWorkspaces(db) }),
    [CommandName.WorkspacesCreate]: ({ rootPath }) => {
      const creation = createWorkspaceAt(db, rootPath)
      if (creation.created) emit({ type: EventType.WorkspaceUpdated, workspace: creation.workspace })
      return creation
    },
    [CommandName.WorkspacesOpen]: ({ id }) => {
      const { workspace, selectedTaskId, uiState } = openWorkspace(db, id)
      emit({ type: EventType.WorkspaceUpdated, workspace })
      for (const entry of uiState) {
        emit({ type: EventType.UiStateChanged, entry })
        // The restored selection is the task you're now viewing, so it's read.
        noteUiStateSet(context, entry)
      }
      return { workspace, selectedTaskId }
    },
    [CommandName.WorkspacesReveal]: ({ id }) => {
      const workspace = getWorkspace(db, id)
      if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${id}`)
      context.revealPath(workspace.rootPath)
      return null
    },
    [CommandName.WorkspacesRemove]: ({ id }) => {
      removeWorkspace(context, id)
      return null
    },
    [CommandName.WorkspacesUpdate]: ({ id, patch }) => {
      const workspace = changeWorkspace(db, id, patch)
      emit({ type: EventType.WorkspaceUpdated, workspace })
      return { workspace }
    },
    [CommandName.DialogChooseFolder]: async () => ({ path: await chooseFolder() }),
    [CommandName.TasksList]: ({ workspaceId }) => ({ tasks: listTasks(db, workspaceId) }),
    [CommandName.TasksListActive]: ({ workspaceId }) => ({
      tasks: listActiveTasks(db, workspaceId),
      done: countDoneTasks(db, workspaceId),
    }),
    [CommandName.TasksListDone]: (request) => listDoneTasks(db, request),
    [CommandName.TasksGet]: ({ ids }) => ({ tasks: getTasks(db, ids) }),
    [CommandName.TasksCreate]: ({ workspaceId }) => ({ task: createTask(context, workspaceId) }),
    [CommandName.TasksMarkDone]: ({ id }) => ({ task: markTaskDone(context, id) }),
    [CommandName.TasksReopen]: ({ id }) => ({ task: reopenTask(context, id) }),
    [CommandName.TasksUpdate]: ({ id, patch }) => ({ task: changeTask(context, id, patch) }),
    [CommandName.TasksDelete]: ({ id }) => {
      deleteTask(context, id)
      return null
    },
    [CommandName.TasksSend]: ({ id, text, images }) => ({ message: runner.send(id, text, images) }),
    [CommandName.TasksStop]: async ({ id }) => ({ task: await runner.stop(id) }),
    [CommandName.TasksRetry]: ({ id, model }) => ({ task: runner.retry(id, model) }),
    [CommandName.TasksCompact]: ({ id }) => ({ task: runner.compact(id) }),
    [CommandName.SubagentsStop]: async ({ taskId, toolUseId }) => {
      await runner.stopSubagent(taskId, toolUseId)
      return null
    },
    [CommandName.WatchersListLive]: () => ({ watchers: listLiveWatchers(db).map(publicWatcher) }),
    [CommandName.WatchersStop]: async ({ taskId, id }) => {
      await runner.stopWatcher(taskId, id)
      return null
    },
    [CommandName.TasksHistory]: ({ id }) => {
      requireTask(db, id)
      return {
        messages: listMessages(db, id),
        toolEvents: listToolEvents(db, id),
        queuedMessages: listQueuedMessages(db, id),
        questionSets: listQuestionSets(db, id),
        permissionRequests: listPermissionRequests(db, id),
        openFiles: getOpenFiles(db, id),
        todos: todoListFor(db, id),
        artifacts: listArtifacts(db, id),
        artifactGroups: listArtifactGroups(db, id),
        handoff: getHandoff(db, id) ?? null,
        watchers: listWatchers(db, id).map(publicWatcher),
        commits: listTaskCommits(db, id),
      }
    },
    [CommandName.ChangesFiles]: async ({ taskId, id }) => ({ files: await commitFiles(changes, taskId, id) }),
    [CommandName.ChangesOpenFile]: async ({ taskId, id, path }) => ({
      openFiles: await openCommitFile(changes, taskId, id, path),
    }),
    [CommandName.ChangesRepository]: async ({ taskId }) => ({
      repository: await workspaceInRepository(changes, taskId),
    }),
    [CommandName.QueueAdd]: ({ taskId, text, images }) => ({ queuedMessage: runner.queue(taskId, text, images) }),
    [CommandName.QueueEdit]: ({ id, text }) => ({ queuedMessage: editQueuedMessage(context, id, text) }),
    [CommandName.QueueRemove]: ({ id }) => {
      removeQueuedMessage(context, id)
      return null
    },
    [CommandName.ImagesGet]: ({ id }) => {
      const image = getImage(db, id)
      if (image === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No image ${id}`)
      return { image }
    },
    [CommandName.DraftsGet]: ({ taskId }) => {
      requireTask(db, taskId)
      return { draft: getInputDraft(db, taskId) ?? null }
    },
    [CommandName.DraftsSet]: (change) => {
      setInputDraft(db, change)
      return null
    },
    [CommandName.QuestionsAnswer]: ({ id, answers }) => ({ questionSet: runner.answer(id, answers) }),
    [CommandName.PermissionsAnswer]: ({ id, decision }) => ({
      permissionRequest: runner.answerPermission(id, decision),
    }),
    [CommandName.FilesRead]: async ({ taskId, path }) => {
      const commitFile = parseCommitFileKey(path)
      return {
        content:
          commitFile === null
            ? await readTaskFile(context, taskId, path)
            : await readCommitFile(changes, taskId, commitFile),
      }
    },
    [CommandName.FilesOpen]: ({ taskId, path }) => ({ openFiles: openTaskFile(context, taskId, path) }),
    [CommandName.FilesClose]: ({ taskId, path }) => ({ openFiles: closeTaskFile(context, taskId, path) }),
    [CommandName.FilesOpenInEditor]: async ({ taskId, path }) => {
      await openTaskFileInEditor(context, taskId, path)
      return null
    },
    [CommandName.FilesThumbnail]: async ({ taskId, path }) => ({
      thumbnail: await thumbnailOfTaskFile(context, context.thumbnails ?? NO_THUMBNAILS, taskId, path),
    }),
    [CommandName.FilesCopy]: async ({ taskId, path }) => {
      await copyTaskFile(context, taskId, path)
      return null
    },
    [CommandName.FilesReveal]: async ({ taskId, path }) => {
      await revealTaskFile(context, taskId, path)
      return null
    },
    [CommandName.ArtifactsRemove]: ({ taskId, path }) => {
      removeTaskArtifact(context, taskId, path)
      return null
    },
    [CommandName.ArtifactsSetGroupOpen]: ({ taskId, group, open }) => {
      requireTask(db, taskId)
      setArtifactGroupOpen(db, { taskId, group, open })
      return null
    },
    [CommandName.ArtifactsWatch]: ({ taskId }) => {
      requireTask(db, taskId)
      context.artifactWatch?.watch(taskId)
      return null
    },
    // A task deleted while its tab showed it is let go too.
    [CommandName.ArtifactsUnwatch]: ({ taskId }) => {
      context.artifactWatch?.unwatch(taskId)
      return null
    },
    [CommandName.ClipboardWriteText]: async ({ text }) => {
      await writeClipboard(text)
      return null
    },
    [CommandName.UiStateGet]: ({ key }) => ({ value: getUiState(db, key) ?? null }),
    [CommandName.UiStateGetAll]: () => ({ entries: listUiState(db) }),
    [CommandName.UiStateSet]: (entry) => {
      noteSelection(db, entry)
      setUiState(db, entry)
      emit({ type: EventType.UiStateChanged, entry })
      noteUiStateSet(context, entry)
      return null
    },
    [CommandName.SettingsGet]: () => ({ settings: getSettings(db) }),
    [CommandName.ModelsList]: () => ({ models: listModels(db) }),
    [CommandName.SettingsUpdate]: async ({ patch }) => {
      // A new default model keeps the default effort only if it supports it.
      const { defaultModel, defaultEffort } = patch
      const effort = effortWithModel(db, defaultModel, defaultEffort, getSettings(db).defaultEffort)
      const settings = updateSettings(db, effort === undefined ? patch : { ...patch, defaultEffort: effort })
      emit({ type: EventType.SettingsChanged, settings })
      // The endpoint follows the switch and the port: answered once it has started, stopped or moved.
      if (patch.controlEnabled !== undefined || patch.controlPort !== undefined) await endpoint.sync()
      return { settings }
    },
    [CommandName.ControlStatus]: () => ({ status: endpoint.status() }),
    [CommandName.AccountStatus]: () => ({ status: account.status() }),
    [CommandName.ControlRegenerateToken]: () => ({ status: endpoint.regenerateToken() }),
    [CommandName.SearchQuery]: ({ workspaceId, text }) => ({ results: searchTasks(db, workspaceId, text) }),
    [CommandName.PluginsList]: async () => ({ plugins: await plugins.list() }),
    [CommandName.PluginsSetEnabled]: ({ id, enabled }) => ({ plugins: plugins.setEnabled(id, enabled) }),
    [CommandName.PluginsOpenFolder]: async () => {
      await plugins.openFolder()
      return null
    },
    [CommandName.PluginsPlaceView]: ({ id, bounds }) => pluginViews.place(id, bounds),
    [CommandName.TerminalList]: () => ({ tabs: terminals.list() }),
    [CommandName.TerminalCreate]: ({ workspaceId }) => ({ tab: terminals.create(terminalRoot(db, workspaceId)) }),
    [CommandName.TerminalDuplicate]: ({ id }) => ({ tab: terminals.duplicate(id) }),
    [CommandName.TerminalAttach]: ({ id, cols, rows }) => terminals.attach(id, { cols, rows }),
    [CommandName.TerminalWrite]: ({ id, data }) => {
      terminals.write(id, data)
      return null
    },
    [CommandName.TerminalResize]: ({ id, cols, rows }) => {
      terminals.resize(id, { cols, rows })
      return null
    },
    [CommandName.TerminalRename]: ({ id, name }) => {
      terminals.rename(id, name.trim())
      return null
    },
    [CommandName.TerminalClear]: ({ id }) => {
      terminals.clear(id)
      return null
    },
    [CommandName.TerminalInterrupt]: ({ id }) => {
      terminals.interrupt(id)
      return null
    },
    [CommandName.TerminalClose]: ({ id }) => {
      terminals.close(id)
      return null
    },
    [CommandName.MenuUpdate]: (state) => {
      context.updateMenu?.(state)
      return null
    },
    [CommandName.WindowClose]: () => {
      context.closeWindow?.()
      return null
    },
    [CommandName.LogRendererError]: (error) => {
      renderer.error('renderer error', { ...error })
      return null
    },
    [CommandName.MenuBarGet]: () => ({ snapshot: readMenuBarSnapshot(db) }),
    [CommandName.MenuBarOpenTask]: ({ id }) => {
      requireTask(db, id)
      context.menuBar?.openTask(id)
      return null
    },
    [CommandName.MenuBarOpenGlade]: () => {
      context.menuBar?.openGlade()
      return null
    },
    [CommandName.MenuBarHide]: () => {
      context.menuBar?.hide()
      return null
    },
    [CommandName.MenuBarQuit]: () => {
      context.menuBar?.quit()
      return null
    },
    [CommandName.MenuBarFit]: ({ height }) => {
      context.menuBar?.fit(height)
      return null
    },
  }
}
