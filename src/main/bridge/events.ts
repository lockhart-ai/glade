import { EventType, type GladeEvent } from '../../shared/bridge'
import type { Task } from '../../shared/domain'

/** Sends an event to every window. */
export type Emit = (event: GladeEvent) => void

/** Tells every window a task was created or changed. Whatever writes a task calls this after. */
export function emitTaskUpdated(emit: Emit, task: Task): void {
  emit({ type: EventType.TaskUpdated, task })
}
