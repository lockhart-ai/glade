/**
 * Keeps every window's copy of a task in step with its background work (`Task.backgroundWork`, #430).
 *
 * Whether a task has background work running is read with the task, from its tool log (a subagent's call still
 * running) and its watchers (one whose process runs). Those change without the task itself being written, when a
 * subagent starts or ends or a watcher does, so nothing would tell the windows, the menu bar or the plugin feed that
 * the task now reads differently: that it stopped counting as working, say, and needs you. This hears every event on
 * its way out, and when one of those changes a task's background work, sends the task again.
 *
 * What it remembers is only what each task last said, to tell a change from none: it's worked out again from the
 * database on every launch.
 */
import { EventType, type GladeEvent } from '../../shared/bridge'
import { ToolEventKind, type Task } from '../../shared/domain'
import { isSubagentTool } from '../../shared/subagents'
import { emitTaskUpdated } from '../bridge/events'
import { getTask } from '../db/repositories/tasks'
import type { TaskServiceContext } from './service'

export interface BackgroundWorkWatch {
  /** Hears an event main sends the windows; sends the task again if it changed whether it has background work. */
  observe(event: GladeEvent): void
}

/** Watches the events for changes to a task's background work. `tasks` are the tasks as they stand at launch. */
export function createBackgroundWorkWatch(context: TaskServiceContext, tasks: readonly Task[]): BackgroundWorkWatch {
  const known = new Map<string, boolean>(tasks.map((task) => [task.id, task.backgroundWork]))

  /** A subagent or a watcher of the task changed: sends the task again if its background work did. */
  const check = (taskId: string): void => {
    const task = getTask(context.db, taskId)
    if (task === undefined || task.backgroundWork === (known.get(taskId) ?? false)) return
    // Sending it comes back through `observe`, which notes what it now says.
    emitTaskUpdated(context.emit, task)
  }

  return {
    observe(event) {
      if (event.type === EventType.TaskUpdated) {
        known.set(event.task.id, event.task.backgroundWork)
      } else if (event.type === EventType.TaskDeleted) {
        known.delete(event.taskId)
      } else if (event.type === EventType.WatchersChanged) {
        check(event.taskId)
      } else if (event.type === EventType.ToolEventAppended || event.type === EventType.ToolEventUpdated) {
        const { toolEvent } = event
        if (toolEvent.kind === ToolEventKind.ToolCall && isSubagentTool(toolEvent.name)) check(toolEvent.taskId)
      }
    },
  }
}
