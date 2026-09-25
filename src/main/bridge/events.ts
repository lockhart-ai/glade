import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  PermissionRequestState,
  QuestionSetState,
  type Message,
  type PermissionRequest,
  type QuestionSet,
  type QueuedMessage,
  type Task,
  type TodoList,
  type ToolEvent,
} from '../../shared/domain'

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

/**
 * Tells every window a question set opened, was answered or was withdrawn, by its state: the event for each carries the
 * set as it now is.
 */
export function emitQuestionSet(emit: Emit, questionSet: QuestionSet): void {
  switch (questionSet.state) {
    case QuestionSetState.Open:
      emit({ type: EventType.QuestionOpened, questionSet })
      return
    case QuestionSetState.Answered:
      emit({ type: EventType.QuestionAnswered, questionSet })
      return
    case QuestionSetState.Withdrawn:
      emit({ type: EventType.QuestionWithdrawn, questionSet })
      return
  }
}

/**
 * Tells every window a permission request opened, was answered or was withdrawn, by its state: the event for each
 * carries the request as it now is.
 */
export function emitPermissionRequest(emit: Emit, permissionRequest: PermissionRequest): void {
  switch (permissionRequest.state) {
    case PermissionRequestState.Open:
      emit({ type: EventType.PermissionOpened, permissionRequest })
      return
    case PermissionRequestState.Allowed:
    case PermissionRequestState.Denied:
      emit({ type: EventType.PermissionAnswered, permissionRequest })
      return
    case PermissionRequestState.Withdrawn:
      emit({ type: EventType.PermissionWithdrawn, permissionRequest })
      return
  }
}

/** Tells every window a task's message queue changed, with the whole queue as it now is. */
export function emitQueueChanged(emit: Emit, taskId: string, queuedMessages: readonly QueuedMessage[]): void {
  emit({ type: EventType.QueueChanged, taskId, queuedMessages })
}

/** Tells every window a task's todo list changed, with the whole list as it now is. */
export function emitTodosChanged(emit: Emit, taskId: string, todos: TodoList | null): void {
  emit({ type: EventType.TodosChanged, taskId, todos })
}
