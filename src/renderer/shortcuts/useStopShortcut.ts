import { TaskActivity } from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { useCommand } from '../commands/hooks'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'

/**
 * Stop the agent (⌘.) stops the selected task's agent while it's working, wherever the focus is (typing in the input
 * bar included). A task waiting on a permission card stops too: stopping withdraws the card (#511), and so does one
 * waiting on a question card, since stopping withdraws the questions (#647). A failure to stop
 * shows as a toast. Must be used under a `ToastProvider`.
 */
export function useStopShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const stopTask = useGladeStore((state) => state.stopTask)
  const toast = useToast()
  const workingTaskId =
    task !== undefined && (task.activity === TaskActivity.Working || task.awaitingPermission || task.asking)
      ? task.id
      : null
  useCommand(WindowCommandId.StopAgent, () => {
    if (workingTaskId === null) return
    stopTask(workingTaskId).catch((error: unknown) => {
      toast.show({ message: describeFailure(error) })
    })
  })
}
