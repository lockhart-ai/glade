import type { Database } from 'better-sqlite3'
import { CommandName, EventType, type CommandRequest, type CommandResponse, type GladeEvent } from '../../shared/bridge'
import type { Task } from '../../shared/domain'
import { listTasks } from '../db/repositories/tasks'
import { getUiState, listUiState, setUiState } from '../db/repositories/ui-state'
import { listWorkspaces } from '../db/repositories/workspaces'

/**
 * One handler per command, taking the parsed request. A command in `CommandMap` without a handler here, or a handler
 * whose request or response doesn't match the map, fails the typecheck.
 */
export type Handlers = {
  readonly [C in CommandName]: (request: CommandRequest<C>) => CommandResponse<C> | Promise<CommandResponse<C>>
}

/** Sends an event to every window. */
export type Emit = (event: GladeEvent) => void

export interface HandlerContext {
  readonly db: Database
  readonly emit: Emit
}

export function createHandlers({ db, emit }: HandlerContext): Handlers {
  return {
    [CommandName.WorkspacesList]: () => ({ workspaces: listWorkspaces(db) }),
    [CommandName.TasksList]: ({ workspaceId }) => ({ tasks: listTasks(db, workspaceId) }),
    [CommandName.UiStateGet]: ({ key }) => ({ value: getUiState(db, key) ?? null }),
    [CommandName.UiStateGetAll]: () => ({ entries: listUiState(db) }),
    [CommandName.UiStateSet]: (entry) => {
      setUiState(db, entry)
      emit({ type: EventType.UiStateChanged, entry })
      return null
    },
  }
}

/** Tells every window a task was created or changed. Whatever writes a task (P1's task commands) calls this after. */
export function emitTaskUpdated(emit: Emit, task: Task): void {
  emit({ type: EventType.TaskUpdated, task })
}
