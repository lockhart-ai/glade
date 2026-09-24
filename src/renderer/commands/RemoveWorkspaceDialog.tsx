import { ConfirmDialog, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** The question the confirmation asks about a workspace. */
export function removeWorkspaceQuestion(name: string): string {
  return `Remove “${name}” from the list?`
}

/** What the confirmation says removing does to a workspace with `tasks` tasks, and what it leaves alone. */
export function removeWorkspaceMessage(tasks: number): string {
  const what =
    tasks === 0
      ? 'It has no tasks.'
      : `Its ${tasks === 1 ? 'task is' : `${String(tasks)} tasks are`} deleted from Glade, with their chats and tool logs, and their agents are stopped.`
  return `${what} The folder and its files on disk aren't touched.`
}

/**
 * The confirmation Remove from list… asks for (`requestRemoveWorkspace`): nothing is removed until you choose Remove.
 * Cancel, Esc or a click outside keeps the workspace.
 */
export function RemoveWorkspaceDialog(): React.JSX.Element | null {
  const workspace = useGladeStore((state) => state.workspaces.find(({ id }) => id === state.removingWorkspaceId))
  const tasks = useGladeStore(
    (state) => Object.values(state.tasks).filter((task) => task.workspaceId === state.removingWorkspaceId).length,
  )
  const cancel = useGladeStore((state) => state.cancelRemoveWorkspace)
  const removeWorkspace = useGladeStore((state) => state.removeWorkspace)
  const toast = useToast()
  if (workspace === undefined) return null

  const confirm = async (): Promise<void> => {
    try {
      await removeWorkspace(workspace.id)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
  }

  return (
    <ConfirmDialog
      open
      title={removeWorkspaceQuestion(workspace.name)}
      message={removeWorkspaceMessage(tasks)}
      confirmLabel="Remove"
      destructive
      onConfirm={() => void confirm()}
      onCancel={cancel}
    />
  )
}
