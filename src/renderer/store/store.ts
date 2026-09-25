import { createStore, type StoreApi } from 'zustand/vanilla'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import type { Command } from '../../shared/commands'
import { PluginStatus } from '../../shared/plugins'
import { UiStateKey, type OpenFiles, type Task, type UiStateEntry, type Workspace } from '../../shared/domain'
import { DONE_PAGE_SIZE, inDoneList } from '../../shared/doneList'
import { parseTaskFilter } from '../../shared/attention'
import { DEFAULT_SETTINGS_SECTION } from '../settings/sections'
import { collapsedEntry, isCollapsed, Panel } from '../panels/panels'
import { PanelTab, parsePanelTab } from '../right-panel/panelModel'
import { listedTaskIds, selectionAfterDeleting } from '../task-list/sections'
import { activeTerminalTab, commandToPaste, cycledTab } from '../terminal/terminalModel'
import type { ImageData } from '../../shared/images'
import type { TerminalTab } from '../../shared/terminal'
import { describeFailure, lastOpenedWorkspace, loadSnapshot } from './hydrate'
import { doneListKey, isLoaded, withDonePage, withLoadedTasks } from './doneLists'
import { applyEvent, withHistory, withOpenedWorkspace } from './reducer'
import { HydrationStatus, INITIAL_DATA, type GladeState, type TerminalEvent } from './state'

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

    // Each terminal tab's terminals, which hear its output straight from main's events, never through the store.
    const terminalListeners = new Map<string, Set<(event: TerminalEvent) => void>>()

    // The stored images fetched so far, by id: an image never changes, so each is fetched once.
    const images = new Map<string, Promise<ImageData>>()

    // The page of each Done section loading now, by `doneListKey`: a second call waits for it rather than loading more.
    const doneLoads = new Map<string, Promise<void>>()

    // Every task deleted since the window opened: an answer that was on its way when the task went mustn't bring it back.
    const deletedTaskIds = new Set<string>()

    // Adds tasks loaded from main, leaving out any deleted meanwhile.
    const addLoaded = (tasks: readonly Task[]): void => {
      set((state) =>
        withLoadedTasks(
          state,
          tasks.filter(({ id }) => !deletedTaskIds.has(id)),
        ),
      )
    }

    // Loads the tasks the store doesn't have yet, e.g. a done task a search found below the Done pages loaded so far.
    const loadTasks = async (ids: readonly string[]): Promise<void> => {
      const { tasks } = get()
      const missing = ids.filter((id) => !(id in tasks) && !deletedTaskIds.has(id))
      if (missing.length === 0) return
      addLoaded((await bridge.invoke(CommandName.TasksGet, { ids: missing })).tasks)
    }

    // The UI state values this window has written, by key, oldest first, until main's echo of each comes back. Main
    // broadcasts every write in the order it stored them; while a newer write of ours is on its way, an older value
    // (our own echo, or anyone's) would undo it in the meantime, so it's left out. Pressing an arrow key on a resize
    // handle faster than main echoed lost steps that way.
    const unechoed = new Map<UiStateKey, UiStateEntry[]>()

    // Whether a UI state change from main is older than a write of ours that's still on its way, consuming our echo.
    const supersededByOwnWrite = ({ key, value }: UiStateEntry): boolean => {
      const writes = unechoed.get(key)
      if (writes === undefined) return false
      if (writes[0]?.value === value) writes.shift()
      if (writes.length > 0) return true
      unechoed.delete(key)
      return false
    }

    // A write main refused never comes back, so it stops holding changes back.
    const forgetWrite = (entry: UiStateEntry): void => {
      const writes = unechoed.get(entry.key)
      if (writes === undefined) return
      const remaining = writes.filter((write) => write !== entry)
      if (remaining.length > 0) unechoed.set(entry.key, remaining)
      else unechoed.delete(entry.key)
    }

    // Who runs the menu bar's commands: the window, once it's showing.
    const commandListeners = new Set<(command: Command) => void>()

    const onEvent = (event: GladeEvent): void => {
      if (event.type === EventType.TerminalOutput || event.type === EventType.TerminalCleared) {
        for (const listener of terminalListeners.get(event.tabId) ?? []) listener(event)
        return
      }
      if (event.type === EventType.MenuCommand) {
        for (const listener of commandListeners) listener(event.command)
        return
      }
      if (event.type === EventType.TaskOpenRequested) {
        if (pending === null) void get().selectTask(event.taskId)
        else openWhenLoaded = event.taskId
        return
      }
      if (event.type === EventType.TaskDeleted) deletedTaskIds.add(event.taskId)
      if (event.type === EventType.UiStateChanged && supersededByOwnWrite(event.entry)) return
      if (pending !== null) {
        pending.push(event)
        return
      }
      set((state) => applyEvent(state, event))
      if (event.type === EventType.FileShown) showPanelTab(event.taskId, PanelTab.Files)
    }

    const setUiState = async (entry: UiStateEntry): Promise<void> => {
      // A copy of its own, so forgetting it forgets this write and no other of the same value.
      const write = { ...entry }
      unechoed.set(entry.key, [...(unechoed.get(entry.key) ?? []), write])
      set((state) => applyEvent(state, { type: EventType.UiStateChanged, entry }))
      try {
        await bridge.invoke(CommandName.UiStateSet, entry)
      } catch (error) {
        forgetWrite(write)
        throw error
      }
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

    // Main broadcasts the new tab too; adding it from the answer as well means it's there whichever arrives first.
    const withTerminalTab = (tab: TerminalTab): void => {
      if (get().terminalTabs.some(({ id }) => id === tab.id)) return
      set(({ terminalTabs }) => ({ terminalTabs: [...terminalTabs, tab] }))
    }

    const requestTerminalFocus = (): void => {
      set(({ terminalFocusRequest }) => ({ terminalFocusRequest: terminalFocusRequest + 1 }))
    }

    // Opens the bottom bar if it's collapsed, so the terminal shows.
    const showBottomBar = async (): Promise<void> => {
      if (isCollapsed(get().uiState, Panel.BottomBar)) await setUiState(collapsedEntry(Panel.BottomBar, false))
    }

    // Shows a new terminal tab, with the focus in it.
    const showNewTerminal = async (tab: TerminalTab): Promise<TerminalTab> => {
      withTerminalTab(tab)
      await setUiState({ key: UiStateKey.TerminalTab, value: tab.id })
      await showBottomBar()
      requestTerminalFocus()
      return tab
    }

    const applyOpenFiles = ({ openFiles }: { openFiles: OpenFiles }): void => {
      set((state) => applyEvent(state, { type: EventType.OpenFilesChanged, openFiles }))
    }

    // Main broadcasts what opening changed as events; applying the answer too keeps the store right whichever arrives
    // first.
    // The task main restored as the workspace's selection has its logs loaded, as selecting it would.
    const open = async (workspaceId: string): Promise<Workspace> => {
      const { workspace, selectedTaskId } = await bridge.invoke(CommandName.WorkspacesOpen, { id: workspaceId })
      if (selectedTaskId !== null) await loadTasks([selectedTaskId])
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

      // Main broadcasts the change too; applying the answer as well keeps the store right whichever arrives first.
      async updateWorkspace(workspaceId, patch) {
        const { workspace } = await bridge.invoke(CommandName.WorkspacesUpdate, { id: workspaceId, patch })
        set((state) => applyEvent(state, { type: EventType.WorkspaceUpdated, workspace }))
      },

      // Shown at once, then as main saved them.
      async updateSettings(patch) {
        set((state) => ({ settings: { ...state.settings, ...patch } }))
        const { settings } = await bridge.invoke(CommandName.SettingsUpdate, { patch })
        set({ settings })
      },

      openSettings(section = DEFAULT_SETTINGS_SECTION) {
        set({ settingsSection: section })
      },

      closeSettings() {
        set({ settingsSection: null })
      },

      async loadPlugins() {
        const { plugins } = await bridge.invoke(CommandName.PluginsList, {})
        set({ plugins })
      },

      // Shown at once, then as main saved it.
      async setPluginEnabled(id, enabled) {
        set((state) => ({
          plugins:
            state.plugins?.map((plugin) =>
              plugin.folder === id && plugin.status === PluginStatus.Valid ? { ...plugin, enabled } : plugin,
            ) ?? null,
        }))
        try {
          const { plugins } = await bridge.invoke(CommandName.PluginsSetEnabled, { id, enabled })
          set({ plugins })
        } catch (error) {
          // Its folder was removed, say: show the plugins as they are now, then say why it didn't change.
          await get().loadPlugins()
          throw error
        }
      },

      async openPluginsFolder() {
        await bridge.invoke(CommandName.PluginsOpenFolder, {})
      },

      async placePluginView(id, bounds) {
        const { status } = await bridge.invoke(CommandName.PluginsPlaceView, { id, bounds })
        set((state) => ({ pluginStatuses: { ...state.pluginStatuses, [id]: status } }))
      },

      async revealWorkspace(workspaceId) {
        await bridge.invoke(CommandName.WorkspacesReveal, { id: workspaceId })
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
        if (taskId !== null) await loadTasks([taskId])
        const { selectedWorkspaceId, tasks } = get()
        const task = taskId === null ? undefined : tasks[taskId]
        if (task !== undefined && task.workspaceId !== selectedWorkspaceId) {
          await setUiState({ key: UiStateKey.ActiveWorkspaceId, value: task.workspaceId })
        }
        await setUiState({ key: UiStateKey.SelectedTaskId, value: taskId ?? NONE })
        if (taskId !== null) await get().loadHistory(taskId)
      },

      loadDonePage(workspaceId, filter) {
        const key = doneListKey(workspaceId, filter)
        const loading = doneLoads.get(key)
        if (loading !== undefined) return loading
        const pages = get().doneLists[key]
        if (pages?.hasMore === false) return Promise.resolve()
        const after = pages?.end ?? null
        const load = bridge
          .invoke(CommandName.TasksListDone, { workspaceId, filter, after, limit: DONE_PAGE_SIZE })
          .then((page) => {
            const tasks = page.tasks.filter(({ id }) => !deletedTaskIds.has(id))
            set((state) => withDonePage(state, workspaceId, filter, { ...page, tasks }))
          })
          .finally(() => {
            doneLoads.delete(key)
          })
        doneLoads.set(key, load)
        return load
      },

      async loadDoneThrough(workspaceId, filter, taskId) {
        const key = doneListKey(workspaceId, filter)
        if (taskId !== null) await loadTasks([taskId])
        for (;;) {
          const { doneLists, tasks } = get()
          const pages = doneLists[key]
          if (pages?.hasMore === false) return
          const task = taskId === null ? undefined : tasks[taskId]
          if (pages !== undefined && taskId !== null) {
            if (task === undefined || !inDoneList(task, workspaceId, filter) || isLoaded(task, pages)) return
          }
          await get().loadDonePage(workspaceId, filter)
          // A page that brought nothing new (the section changed under it) would load forever.
          if (get().doneLists[key]?.end === pages?.end && pages !== undefined) return
        }
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
        const task = get().tasks[taskId]
        const selected = task !== undefined && taskId === get().selectedTaskId
        // The last row of the Done pages loaded so far is followed by the next page's first: load it to select it.
        if (selected && listedTaskIds(get(), task.workspaceId).at(-1) === taskId) {
          await get().loadDonePage(task.workspaceId, parseTaskFilter(get().uiState[UiStateKey.TaskFilter]))
        }
        const next = selected ? selectionAfterDeleting(listedTaskIds(get(), task.workspaceId), taskId) : null
        if (get().deletingTaskId === taskId) set({ deletingTaskId: null })
        await bridge.invoke(CommandName.TasksDelete, { id: taskId })
        deletedTaskIds.add(taskId)
        // Main's task.deleted event normally arrives first; make sure the task is gone either way.
        set((state) => applyEvent(state, { type: EventType.TaskDeleted, taskId }))
        if (selected) await get().selectTask(next)
      },

      async sendMessage(taskId, text, images = []) {
        await bridge.invoke(CommandName.TasksSend, { id: taskId, text, ...(images.length > 0 ? { images } : {}) })
      },

      async queueMessage(taskId, text, images = []) {
        await bridge.invoke(CommandName.QueueAdd, { taskId, text, ...(images.length > 0 ? { images } : {}) })
      },

      loadImage(id) {
        const cached = images.get(id)
        if (cached !== undefined) return cached
        const loading = bridge.invoke(CommandName.ImagesGet, { id }).then(({ image }) => image)
        images.set(id, loading)
        loading.catch(() => images.delete(id))
        return loading
      },

      async answerQuestions(id, answers) {
        await bridge.invoke(CommandName.QuestionsAnswer, { id, answers })
      },

      async answerPermission(id, decision) {
        await bridge.invoke(CommandName.PermissionsAnswer, { id, decision })
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
        // A result can be a done task below the Done pages loaded so far: its row needs the task.
        await loadTasks(results.map(({ taskId }) => taskId))
        return results
      },

      async openSearchResult(taskId) {
        await get().selectTask(taskId)
        set(({ matchRevealRequest }) => ({ matchRevealRequest: matchRevealRequest + 1 }))
      },

      async createTerminal() {
        const { tab } = await bridge.invoke(CommandName.TerminalCreate, { workspaceId: get().selectedWorkspaceId })
        return showNewTerminal(tab)
      },

      async selectTerminal(tabId) {
        await setUiState({ key: UiStateKey.TerminalTab, value: tabId })
        requestTerminalFocus()
      },

      async cycleTerminal(step) {
        const { terminalTabs, uiState } = get()
        const active = activeTerminalTab(terminalTabs, uiState)
        if (active === undefined) return
        const next = cycledTab(
          terminalTabs.map(({ id }) => id),
          active.id,
          step,
        )
        if (next === undefined || next === active.id) return
        await setUiState({ key: UiStateKey.TerminalTab, value: next })
        requestTerminalFocus()
      },

      async duplicateTerminal(tabId) {
        const { tab } = await bridge.invoke(CommandName.TerminalDuplicate, { id: tabId })
        await showNewTerminal(tab)
      },

      async closeTerminal(tabId) {
        const { terminalTabs, uiState } = get()
        const closingActive = activeTerminalTab(terminalTabs, uiState)?.id === tabId
        const next = selectionAfterDeleting(
          terminalTabs.map(({ id }) => id),
          tabId,
        )
        await bridge.invoke(CommandName.TerminalClose, { id: tabId })
        // Main's terminal.tabsChanged normally arrives first; make sure the tab is gone either way.
        set((state) => ({ terminalTabs: state.terminalTabs.filter(({ id }) => id !== tabId) }))
        if (!closingActive || next === null) return
        await setUiState({ key: UiStateKey.TerminalTab, value: next })
        requestTerminalFocus()
      },

      startTerminalRename(tabId) {
        set({ renamingTerminalId: tabId })
      },

      cancelTerminalRename() {
        set({ renamingTerminalId: null })
      },

      async renameTerminal(tabId, name) {
        const trimmed = name.trim()
        if (trimmed === '') return false
        const tab = get().terminalTabs.find(({ id }) => id === tabId)
        if (tab !== undefined && trimmed !== tab.name) {
          await bridge.invoke(CommandName.TerminalRename, { id: tabId, name: trimmed })
        }
        if (get().renamingTerminalId === tabId) set({ renamingTerminalId: null })
        return true
      },

      async clearTerminal(tabId) {
        await bridge.invoke(CommandName.TerminalClear, { id: tabId })
      },

      async interruptTerminal(tabId) {
        await bridge.invoke(CommandName.TerminalInterrupt, { id: tabId })
      },

      attachTerminal(tabId, { cols, rows }) {
        return bridge.invoke(CommandName.TerminalAttach, { id: tabId, cols, rows })
      },

      async writeTerminal(tabId, data) {
        await bridge.invoke(CommandName.TerminalWrite, { id: tabId, data })
      },

      async resizeTerminal(tabId, { cols, rows }) {
        await bridge.invoke(CommandName.TerminalResize, { id: tabId, cols, rows })
      },

      subscribeTerminal(tabId, listener) {
        const listeners = terminalListeners.get(tabId) ?? new Set()
        listeners.add(listener)
        terminalListeners.set(tabId, listeners)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) terminalListeners.delete(tabId)
        }
      },

      async focusTerminal() {
        if (get().terminalTabs.length === 0) {
          await get().createTerminal()
          return
        }
        await showBottomBar()
        requestTerminalFocus()
      },

      async runInTerminal(command) {
        const { terminalTabs, uiState } = get()
        const tab = activeTerminalTab(terminalTabs, uiState) ?? (await get().createTerminal())
        await showBottomBar()
        set(({ terminalPaste }) => ({
          terminalPaste: { tabId: tab.id, text: commandToPaste(command), request: (terminalPaste?.request ?? 0) + 1 },
        }))
      },

      takeTerminalPaste(request) {
        if (get().terminalPaste?.request === request) set({ terminalPaste: null })
      },
    }
  })
}
