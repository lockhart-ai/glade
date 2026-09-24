import { EventType, type GladeEvent } from '../../shared/bridge'
import type { Message, Task, ToolEvent } from '../../shared/domain'

/** Sends an event to every window. */
export type Emit = (event: GladeEvent) => void

/** Tells every window a task was created or changed. Whatever writes a task calls this after. */
export function emitTaskUpdated(emit: Emit, task: Task): void {
  emit({ type: EventType.TaskUpdated, task })
}

/** Tells every window a message was appended to a task's chat log. */
export function emitMessageAppended(emit: Emit, message: Message): void {
  emit({ type: EventType.MessageAppended, message })
}

/** Tells every window an entry was appended to a task's tool log. */
export function emitToolEventAppended(emit: Emit, toolEvent: ToolEvent): void {
  emit({ type: EventType.ToolEventAppended, toolEvent })
}

/** Tells every window a tool log entry changed. */
export function emitToolEventUpdated(emit: Emit, toolEvent: ToolEvent): void {
  emit({ type: EventType.ToolEventUpdated, toolEvent })
}
