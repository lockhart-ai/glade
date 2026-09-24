import { createStore, type StoreApi } from 'zustand/vanilla'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { UiStateKey, type UiStateEntry, type Workspace } from '../../shared/domain'
import { describeFailure, loadSnapshot } from './hydrate'
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

    const onEvent = (event: GladeEvent): void => {
      if (pending === null) set((state) => applyEvent(state, event))
      else pending.push(event)
    }

    const setUiState = async (entry: UiStateEntry): Promise<void> => {
      set((state) => applyEvent(state, { type: EventType.UiStateChanged, entry }))
      await bridge.invoke(CommandName.UiStateSet, entry)
    }

    // Main broadcasts what opening changed as events; applying the answer too keeps the store right whichever arrives
    // first.
    const open = async (workspaceId: string): Promise<Workspace> => {
      const { workspace } = await bridge.invoke(CommandName.WorkspacesOpen, { id: workspaceId })
      set((state) => withOpenedWorkspace(state, workspace))
      return workspace
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

      async openWorkspace(workspaceId) {
        await open(workspaceId)
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
        if (hydration.status !== HydrationStatus.Ready || selectedTaskId === null) return
        try {
          await get().loadHistory(selectedTaskId)
        } catch (error) {
          set({ hydration: { status: HydrationStatus.Failed, message: describeFailure(error) } })
        }
      },

      async selectWorkspace(workspaceId) {
        const { selectedTaskId, tasks } = get()
        await setUiState({ key: UiStateKey.ActiveWorkspaceId, value: workspaceId ?? NONE })
        const task = selectedTaskId === null ? undefined : tasks[selectedTaskId]
        if (task !== undefined && task.workspaceId !== workspaceId) {
          await setUiState({ key: UiStateKey.SelectedTaskId, value: NONE })
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

      async sendMessage(taskId, text) {
        await bridge.invoke(CommandName.TasksSend, { id: taskId, text })
      },

      async stopTask(taskId) {
        await bridge.invoke(CommandName.TasksStop, { id: taskId })
      },

      focusTurn(taskId, turn) {
        set(({ toolLogFocus }) => ({ toolLogFocus: { taskId, turn, request: (toolLogFocus?.request ?? 0) + 1 } }))
      },
    }
  })
}
