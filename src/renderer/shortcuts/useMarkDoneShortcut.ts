import { CommandId } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import { canMarkDone } from '../task-header/headerModel'
import { useMarkDone } from '../task-header/useMarkDone'

/**
 * Mark done (⌘⇧D) marks the selected task done, as the header's Mark done does, wherever the focus is. It does nothing
 * when the header wouldn't let you: a done or new task, or one whose agent is working. Must be used under a
 * `ToastProvider`.
 */
export function useMarkDoneShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const markDone = useMarkDone()
  const taskId = task !== undefined && canMarkDone(task) ? task.id : null
  useCommand(CommandId.MarkDone, () => {
    if (taskId !== null) void markDone(taskId)
  })
}
