/**
 * What a plugin can see: the tasks and subagents its feed has told it of since its last `ready` (`./feed`), kept from
 * the very events its view sends it. A plugin's `openTask` (`docs/plugin-api.md`, "Messages") may open only a task in
 * here that's still active, and only a subagent it was told of in that task.
 */
import { PluginEventType, PluginTaskState, type PluginEvent } from '../../shared/plugin-api'

/** Why a plugin can't open what it asked to; logged, never shown. */
export enum SightRefusal {
  /** It was never told of the task (or not since its last `ready`), or the task has been deleted since. */
  UnknownTask = 'unknown_task',
  /** It was told the task is done. */
  DoneTask = 'done_task',
  /** It was never told of the subagent in that task: unknown, or another task's. */
  UnknownSubagent = 'unknown_subagent',
}

/** What a plugin can see, from what it's sent. */
export interface PluginSight {
  /** Takes in an event as it's sent to the plugin's page. */
  see(event: PluginEvent): void
  /** Why the plugin can't open the task (and subagent), or null when it can. */
  refusal(taskId: string, subagentId: string | null): SightRefusal | null
}

export function createPluginSight(): PluginSight {
  /** Whether each task it was told of is still active, by id. */
  const tasks = new Map<string, boolean>()
  /** The task of each subagent it was told of, by the subagent's id. */
  const subagents = new Map<string, string>()

  const forgetTask = (taskId: string): void => {
    tasks.delete(taskId)
    for (const [id, owner] of subagents) if (owner === taskId) subagents.delete(id)
  }

  return {
    see(event) {
      switch (event.type) {
        case PluginEventType.Snapshot:
          tasks.clear()
          subagents.clear()
          for (const task of event.tasks) tasks.set(task.id, task.state === PluginTaskState.Active)
          for (const subagent of event.subagents) subagents.set(subagent.id, subagent.taskId)
          return
        case PluginEventType.TaskCreated:
        case PluginEventType.TaskUpdated:
          tasks.set(event.task.id, event.task.state === PluginTaskState.Active)
          return
        case PluginEventType.TaskDeleted:
          forgetTask(event.taskId)
          return
        case PluginEventType.SubagentStarted:
        case PluginEventType.SubagentUpdated:
          subagents.set(event.subagent.id, event.subagent.taskId)
          return
        // Nothing here names a task or subagent the plugin wasn't told of in the events above.
        case PluginEventType.Hello:
        case PluginEventType.AgentToolCall:
        case PluginEventType.AgentNote:
        case PluginEventType.QuestionOpened:
        case PluginEventType.QuestionClosed:
        case PluginEventType.PermissionOpened:
        case PluginEventType.PermissionClosed:
        case PluginEventType.MachineReading:
        case PluginEventType.SettingsChanged:
          return
      }
    },
    refusal(taskId, subagentId) {
      const active = tasks.get(taskId)
      if (active === undefined) return SightRefusal.UnknownTask
      if (!active) return SightRefusal.DoneTask
      if (subagentId !== null && subagents.get(subagentId) !== taskId) return SightRefusal.UnknownSubagent
      return null
    },
  }
}
