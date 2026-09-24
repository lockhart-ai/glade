import { useCallback } from 'react'
import {
  AppCommandId,
  CommandScope,
  TaskCommandId,
  WorkspaceCommandId,
  type AppCommand,
  type Command,
  type TaskCommand,
  type WorkspaceCommand,
} from '../../shared/commands'
import { useMenuCommands } from '../context-menus/useMenuCommands'
import { requestClose } from './closeRequest'
import { Panel, toggledEntry } from '../panels'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import { useNewTask } from '../task-list/useNewTask'
import { useTaskActions } from '../task-list/useTaskActions'
import { useWorkspaceActions } from '../workspace-switcher/useWorkspaceActions'

/** The panel each toggle command flips. */
const TOGGLED_PANELS = {
  [AppCommandId.ToggleSidebar]: Panel.Sidebar,
  [AppCommandId.ToggleRightPanel]: Panel.RightPanel,
  [AppCommandId.ToggleBottomBar]: Panel.BottomBar,
} as const

/**
 * Runs a command (`src/shared/commands.ts`) as the button, row or menu it stands for does: the menu bar's items, and
 * so their keys, all come here. Failures show as toasts. A command whose task or workspace is gone does nothing. Must
 * be used under a `ToastProvider`.
 */
export function useCommandRunner(): (command: Command) => void {
  const store = useGladeStoreApi()
  const shownWorkspaceId = useGladeStore((state) => state.selectedWorkspaceId)
  const openWorkspaceSettings = useGladeStore((state) => state.openWorkspaceSettings)
  const closeWorkspace = useGladeStore((state) => state.closeWorkspace)
  const requestRemoveWorkspace = useGladeStore((state) => state.requestRemoveWorkspace)
  const closeWindow = useGladeStore((state) => state.closeWindow)
  const newTask = useNewTask(shownWorkspaceId)
  const workspaces = useWorkspaceActions()
  const taskActions = useTaskActions()
  const { run } = useMenuCommands()

  const runApp = useCallback(
    ({ id }: AppCommand): void => {
      switch (id) {
        // The settings modal (P7-03) opens at General for Settings…; until it lands, both open the workspace's.
        case AppCommandId.Settings:
          openWorkspaceSettings()
          return
        case AppCommandId.NewTask:
          void newTask()
          return
        case AppCommandId.Close:
          if (!requestClose()) run(closeWindow)
          return
        case AppCommandId.NewWorkspace:
        case AppCommandId.OpenFolder:
          workspaces.add()
          return
        case AppCommandId.ToggleSidebar:
        case AppCommandId.ToggleRightPanel:
        case AppCommandId.ToggleBottomBar: {
          const { uiState, setUiState } = store.getState()
          run(() => setUiState(toggledEntry(uiState, TOGGLED_PANELS[id])))
          return
        }
      }
    },
    [openWorkspaceSettings, newTask, closeWindow, workspaces, store, run],
  )

  const runWorkspace = useCallback(
    ({ id, workspaceId }: WorkspaceCommand): void => {
      if (!store.getState().workspaces.some((workspace) => workspace.id === workspaceId)) return
      switch (id) {
        case WorkspaceCommandId.Switch:
          workspaces.open(workspaceId)
          return
        // Renaming a workspace and moving its root are done in its settings (P7-03).
        case WorkspaceCommandId.Rename:
        case WorkspaceCommandId.ChangeRoot:
        case WorkspaceCommandId.Settings:
          openWorkspaceSettings()
          return
        case WorkspaceCommandId.RevealRoot:
          workspaces.reveal(workspaceId)
          return
        case WorkspaceCommandId.Close:
          run(() => closeWorkspace(workspaceId))
          return
        case WorkspaceCommandId.Remove:
          requestRemoveWorkspace(workspaceId)
          return
      }
    },
    [store, workspaces, openWorkspaceSettings, closeWorkspace, requestRemoveWorkspace, run],
  )

  const runTask = useCallback(
    ({ id, taskId }: TaskCommand): void => {
      const actions = taskActions(taskId)
      if (actions === null) return
      switch (id) {
        case TaskCommandId.TogglePin:
          actions.togglePin()
          return
        case TaskCommandId.Rename:
          actions.rename()
          return
        case TaskCommandId.MarkUnread:
          actions.markUnread()
          return
        case TaskCommandId.MarkDone:
          actions.markDone()
          return
        case TaskCommandId.Reopen:
          actions.reopen()
          return
        case TaskCommandId.CopyLink:
          actions.copyLink()
          return
        case TaskCommandId.CopyOutcome:
          actions.copyOutcome()
          return
        case TaskCommandId.Delete:
          actions.delete()
          return
      }
    },
    [taskActions],
  )

  return useCallback(
    (command: Command): void => {
      switch (command.scope) {
        case CommandScope.App:
          runApp(command)
          return
        case CommandScope.Workspace:
          runWorkspace(command)
          return
        case CommandScope.Task:
          runTask(command)
          return
      }
    },
    [runApp, runWorkspace, runTask],
  )
}
