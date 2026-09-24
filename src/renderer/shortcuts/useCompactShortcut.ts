import { WindowCommandId } from '../../shared/commands'
import { useCommand } from '../commands/hooks'
import { canCompact, useCompact } from '../context-meter/compact'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'

/**
 * Compact context (⌘⇧K) compacts the selected task's context, as the context meter's Compact now does, wherever the
 * focus is. It does nothing when Compact now is off: a done task, one whose agent is working, or one with no session
 * yet. Must be used under a `ToastProvider`.
 */
export function useCompactShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const compact = useCompact()
  const taskId = task !== undefined && canCompact(task) ? task.id : null
  useCommand(WindowCommandId.CompactContext, () => {
    if (taskId !== null) void compact(taskId)
  })
}
