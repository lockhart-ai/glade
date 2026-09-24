import { TaskActivity } from '../../shared/domain'
import { CommandId } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'

/**
 * Stop the agent (⌘.) stops the selected task's agent while it's working, wherever the focus is (typing in the input
 * bar included). A failure to stop shows as a toast. Must be used under a `ToastProvider`.
 */
export function useStopShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const stopTask = useGladeStore((state) => state.stopTask)
  const toast = useToast()
  const workingTaskId = task?.activity === TaskActivity.Working ? task.id : null
  useCommand(CommandId.StopAgent, () => {
    if (workingTaskId === null) return
    stopTask(workingTaskId).catch((error: unknown) => {
      toast.show({ message: describeFailure(error) })
    })
  })
}
