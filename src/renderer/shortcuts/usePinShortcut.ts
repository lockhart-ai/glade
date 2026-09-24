import { CommandId } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** Pin / unpin (⌘⇧P) pins the selected task, or unpins it, wherever the focus is. Does nothing when no task is selected. */
export function usePinShortcut(): void {
  const taskId = useGladeStore(({ selectedTaskId, tasks }) =>
    selectedTaskId !== null && selectedTaskId in tasks ? selectedTaskId : null,
  )
  const togglePin = useGladeStore((state) => state.togglePin)
  const toast = useToast()
  useCommand(CommandId.TogglePin, () => {
    if (taskId === null) return
    togglePin(taskId).catch((error: unknown) => {
      toast.show({ message: describeFailure(error) })
    })
  })
}
