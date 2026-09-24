import { createStore, type StoreApi } from 'zustand/vanilla'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import type { Command } from '../../shared/commands'
import { UiStateKey, type OpenFiles, type UiStateEntry, type Workspace } from '../../shared/domain'
import { collapsedEntry, isCollapsed, Panel } from '../panels/panels'
import { PanelTab, parsePanelTab } from '../right-panel/panelModel'
import { listedTaskIds, selectionAfterDeleting } from '../task-list/sections'
import { describeFailure, lastOpenedWorkspace, loadSnapshot } from './hydrate'
import { applyEvent, withHistory, withOpenedWorkspace } from './reducer'
import { HydrationStatus, INITIAL_DATA, type GladeState } from './state'

export type GladeStore = StoreApi<GladeState>

/** The value that stores "nothing selected" for a selection key. */
const NONE = ''

/** Creates the renderer's store, talking to main through `bridge`. Call `hydrate()` to load it. */
export function createGladeStore(bridge: GladeBridge): GladeStore {
  return createStore<GladeState>()((set, get) => {
    let subscribed = false
    // While a snapshot loads, events wait here and are applied on top of it, so none is lost or overwritten.
    let pending: GladeEvent[] | null = null

    // A task main asked to open while a snapshot loaded, opened once it has.
    let openWhenLoaded: string | null = null

    // Who runs the menu bar's commands: the window, once it's showing.
    const commandListeners = new Set<(command: Command) => void>()

    const onEvent = (event: GladeEvent): void => {
      if (event.type === EventType.MenuCommand) {
        for (const listener of commandListeners) listener(event.command)
        return
      }
      if (event.type === EventType.TaskOpenRequested) {
        if (pending === null) void get().selectTask(event.taskId)
        else openWhenLoaded = event.taskId
        return
      }
      if (pending !== null) {
        pending.push(event)
        return
      }
      set((state) => applyEvent(state, event))
      if (event.type === EventType.FileShown) showPanelTab(event.taskId, PanelTab.Files)
    }

    const setUiState = async (entry: UiStateEntry): Promise<void> => {
      set((state) => applyEvent(state, { type: EventType.UiStateChanged, entry }))
      await bridge.invoke(CommandName.UiStateSet, entry)
    }

    // Shows a panel tab of the selected task: the right panel opens at it, even when it was collapsed or on another tab.
    // For another task, nothing changes: the panel shows the task you're viewing.
    const showPanelTab = (taskId: string, tab: PanelTab): void => {
      const { selectedTaskId, uiState } = get()
      if (taskId !== selectedTaskId) return
      if (parsePanelTab(uiState[UiStateKey.RightPanelTab]) !== tab) {
        void setUiState({ key: UiStateKey.RightPanelTab, value: tab })
      }
      if (isCollapsed(uiState, Panel.RightPanel)) void setUiState(collapsedEntry(Panel.RightPanel, false))
    }

    const applyOpenFiles = ({ openFiles }: { openFiles: OpenFiles }): void => {
      set((state) => applyEvent(state, { type: EventType.OpenFilesChanged, openFiles }))
    }

    // Main broadcasts what opening changed as events; applying the answer too keeps the store right whichever arrives
    // first.
    // The task main restored as the workspace's selection has its logs loaded, as selecting it would.
    const open = async (workspaceId: string): Promise<Workspace> => {
      const { workspace, selectedTaskId } = await bridge.invoke(CommandName.WorkspacesOpen, { id: workspaceId })
      set((state) => withOpenedWorkspace(state, workspace, selectedTaskId))
      if (selectedTaskId !== null) await get().loadHistory(selectedTaskId)
      return workspace
    }

    // Shows the most recently opened workspace other than `leaving`, or none (the first-run window) when there's no
    // other. Showing none keeps each workspace's own selection, to come back when it's opened again.
    const showAnotherWorkspace = async (leaving: string): Promise<void> => {
      const next = lastOpenedWorkspace(get().workspaces.filter(({ id }) => id !== leaving))
      if (next !== undefined) {
        await open(next.id)
        return
      }
      await setUiState({ key: UiStateKey.ActiveWorkspaceId, value: NONE })
      await setUiState({ key: UiStateKey.SelectedTaskId, value: NONE })
    }

    return {
      ...INITIAL_DATA,

      async createWorkspace(rootPath) {
        const { workspace } = await bridge.invoke(CommandName.WorkspacesCreate, { rootPath })
        return open(workspace.id)
      },

      async chooseFolder() {
        const { path } = await bridge.invoke(CommandName.DialogChooseFolder, {})
        return path
      },

      async addWorkspace() {
        const { path } = await bridge.invoke(CommandName.DialogChooseFolder, {})
        return path === null ? null : get().createWorkspace(path)
      },

      async openWorkspace(workspaceId) {
        await open(workspaceId)
      },

      async revealWorkspace(workspaceId) {
        await bridge.invoke(CommandName.WorkspacesReveal, { id: workspaceId })
      },

      openWorkspaceSettings() {
        set(({ workspaceSettingsRequest }) => ({ workspaceSettingsRequest: workspaceSettingsRequest + 1 }))
      },

      async closeWorkspace(workspaceId) {
        if (get().selectedWorkspaceId === workspaceId) await showAnotherWorkspace(workspaceId)
      },

      requestRemoveWorkspace(workspaceId) {
        set({ removingWorkspaceId: workspaceId })
      },

      cancelRemoveWorkspace() {
        set({ removingWorkspaceId: null })
      },

      async removeWorkspace(workspaceId) {
        const shown = get().selectedWorkspaceId === workspaceId
        if (get().removingWorkspaceId === workspaceId) set({ removingWorkspaceId: null })
        await bridge.invoke(CommandName.WorkspacesRemove, { id: workspaceId })
        // Main's events normally arrive first; make sure the workspace is gone either way.
        set((state) => applyEvent(state, { type: EventType.WorkspaceRemoved, workspaceId }))
        if (shown) await showAnotherWorkspace(workspaceId)
      },

      async closeWindow() {
        await bridge.invoke(CommandName.WindowClose, {})
      },

      async updateMenu(state) {
        await bridge.invoke(CommandName.MenuUpdate, state)
      },

      onCommand(listener) {
        commandListeners.add(listener)
        return () => {
          commandListeners.delete(listener)
        }
      },

      async hydrate() {
        if (!subscribed) {
          bridge.subscribe(onEvent)
          subscribed = true
        }
        const buffered: GladeEvent[] = []
        pending = buffered
        set({ hydration: { status: HydrationStatus.Loading } })
        try {
          const snapshot = await loadSnapshot(bridge)
          set(buffered.reduce(applyEvent, snapshot))
        } catch (error) {
          set({ hydration: { status: HydrationStatus.Failed, message: describeFailure(error) } })
        } finally {
          pending = null
        }
        // The restored task's logs load once events flow again, so none that arrive meanwhile is held back.
        const { hydration, selectedTaskId } = get()
        if (hydration.status !== HydrationStatus.Ready) return
        const opening = openWhenLoaded
        openWhenLoaded = null
        if (opening !== null) {
          await get().selectTask(opening)
          return
        }
        if (selectedTaskId === null) return
        try {
          await get().loadHistory(selectedTaskId)
        } catch (error) {
          set({ hydration: { status: HydrationStatus.Failed, message: describeFailure(error) } })
        }
      },

      async selectTask(taskId) {
        const { selectedWorkspaceId, tasks } = get()
        const task = taskId === null ? undefined : tasks[taskId]
        if (task !== undefined && task.workspaceId !== selectedWorkspaceId) {
          await setUiState({ key: UiStateKey.ActiveWorkspaceId, value: task.workspaceId })
        }
        await setUiState({ key: UiStateKey.SelectedTaskId, value: taskId ?? NONE })
        if (taskId !== null) await get().loadHistory(taskId)
      },

      async loadHistory(taskId) {
        const history = await bridge.invoke(CommandName.TasksHistory, { id: taskId })
        set((state) => withHistory(state, taskId, history))
      },

      setUiState,

      async createTask(workspaceId) {
        const { task } = await bridge.invoke(CommandName.TasksCreate, { workspaceId })
        // Main's task.updated event normally arrives first; make sure the task is here before selecting it.
        if (!(task.id in get().tasks)) set((state) => applyEvent(state, { type: EventType.TaskUpdated, task }))
        await get().selectTask(task.id)
        return task
      },

      async markTaskDone(taskId) {
        await bridge.invoke(CommandName.TasksMarkDone, { id: taskId })
      },

      async reopenTask(taskId) {
        await bridge.invoke(CommandName.TasksReopen, { id: taskId })
      },

      async updateTask(taskId, patch) {
        await bridge.invoke(CommandName.TasksUpdate, { id: taskId, patch })
      },

      async markUnread(taskId) {
        await bridge.invoke(CommandName.TasksUpdate, { id: taskId, patch: { unread: true } })
      },

      async togglePin(taskId) {
        const task = get().tasks[taskId]
        if (task === undefined) return
        await bridge.invoke(CommandName.TasksUpdate, { id: taskId, patch: { pinned: !task.pinned } })
      },

      startRename(taskId) {
        set({ renamingTaskId: taskId })
      },

      cancelRename() {
        set({ renamingTaskId: null })
      },

      async renameTask(taskId, title) {
        const trimmed = title.trim()
        if (trimmed === '') return false
        if (trimmed !== get().tasks[taskId]?.title) {
          await bridge.invoke(CommandName.TasksUpdate, { id: taskId, patch: { title: trimmed } })
        }
        if (get().renamingTaskId === taskId) set({ renamingTaskId: null })
        return true
      },

      requestDelete(taskId) {
        set({ deletingTaskId: taskId })
      },

      cancelDelete() {
        set({ deletingTaskId: null })
      },

      async deleteTask(taskId) {
        const { selectedTaskId, tasks, uiState } = get()
        const task = tasks[taskId]
        const selected = task !== undefined && taskId === selectedTaskId
        const next = selected
          ? selectionAfterDeleting(listedTaskIds(Object.values(tasks), task.workspaceId, uiState), taskId)
          : null
        if (get().deletingTaskId === taskId) set({ deletingTaskId: null })
        await bridge.invoke(CommandName.TasksDelete, { id: taskId })
        // Main's task.deleted event normally arrives first; make sure the task is gone either way.
        set((state) => applyEvent(state, { type: EventType.TaskDeleted, taskId }))
        if (selected) await get().selectTask(next)
      },

      async sendMessage(taskId, text) {
        await bridge.invoke(CommandName.TasksSend, { id: taskId, text })
      },

      async queueMessage(taskId, text) {
        await bridge.invoke(CommandName.QueueAdd, { taskId, text })
      },

      async answerQuestions(id, answers) {
        await bridge.invoke(CommandName.QuestionsAnswer, { id, answers })
      },

      async editQueuedMessage(id, text) {
        await bridge.invoke(CommandName.QueueEdit, { id, text })
      },

      async removeQueuedMessage(id) {
        await bridge.invoke(CommandName.QueueRemove, { id })
      },

      async stopTask(taskId) {
        await bridge.invoke(CommandName.TasksStop, { id: taskId })
      },

      async retryTask(taskId, model) {
        await bridge.invoke(CommandName.TasksRetry, model === undefined ? { id: taskId } : { id: taskId, model })
      },

      async compactTask(taskId) {
        await bridge.invoke(CommandName.TasksCompact, { id: taskId })
      },

      focusTurn(taskId, turn) {
        showPanelTab(taskId, PanelTab.ToolCalls)
        set(({ toolLogFocus }) => ({ toolLogFocus: { taskId, turn, request: (toolLogFocus?.request ?? 0) + 1 } }))
      },

      focusInput() {
        set(({ inputFocusRequest }) => ({ inputFocusRequest: inputFocusRequest + 1 }))
      },

      // Main broadcasts the change too; applying the answer as well keeps the tabs right whichever arrives first.
      async openFile(taskId, path) {
        applyOpenFiles(await bridge.invoke(CommandName.FilesOpen, { taskId, path }))
      },

      async closeFile(taskId, path) {
        applyOpenFiles(await bridge.invoke(CommandName.FilesClose, { taskId, path }))
      },

      async readFile(taskId, path) {
        const { content } = await bridge.invoke(CommandName.FilesRead, { taskId, path })
        return content
      },

      async openInEditor(taskId, path) {
        await bridge.invoke(CommandName.FilesOpenInEditor, { taskId, path })
      },

      async fileInfo(taskId, path) {
        const { info } = await bridge.invoke(CommandName.FilesInfo, { taskId, path })
        return info
      },

      async copyFile(taskId, path) {
        await bridge.invoke(CommandName.FilesCopy, { taskId, path })
      },

      async revealFile(taskId, path) {
        await bridge.invoke(CommandName.FilesReveal, { taskId, path })
      },

      async showFile(taskId, path) {
        await get().openFile(taskId, path)
        showPanelTab(taskId, PanelTab.Files)
      },

      async removeArtifact(taskId, path) {
        await bridge.invoke(CommandName.ArtifactsRemove, { taskId, path })
      },

      async stopSubagent(taskId, toolUseId) {
        await bridge.invoke(CommandName.SubagentsStop, { taskId, toolUseId })
      },

      async copyText(text) {
        await bridge.invoke(CommandName.ClipboardWriteText, { text })
      },

      insertIntoInput(taskId, text) {
        set(({ inputInsertion }) => ({
          inputInsertion: { taskId, text, request: (inputInsertion?.request ?? 0) + 1 },
        }))
      },

      setSearchText(text) {
        set({ searchText: text })
      },

      focusSearch() {
        set(({ searchFocusRequest }) => ({ searchFocusRequest: searchFocusRequest + 1 }))
      },

      async searchTasks(workspaceId, text) {
        const { results } = await bridge.invoke(CommandName.SearchQuery, { workspaceId, text })
        return results
      },

      async openSearchResult(taskId) {
        await get().selectTask(taskId)
        set(({ matchRevealRequest }) => ({ matchRevealRequest: matchRevealRequest + 1 }))
      },
    }
  })
}
