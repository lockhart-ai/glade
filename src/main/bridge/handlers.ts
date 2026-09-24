import type { Database } from 'better-sqlite3'
import { CommandName, EventType, type CommandRequest, type CommandResponse } from '../../shared/bridge'
import { listTasks } from '../db/repositories/tasks'
import { getUiState, listUiState, setUiState } from '../db/repositories/ui-state'
import { listWorkspaces } from '../db/repositories/workspaces'
import { createTask, markTaskDone, reopenTask, updateTaskFromUser } from '../tasks/service'
import type { Emit } from './events'

/**
 * One handler per command, taking the parsed request. A command in `CommandMap` without a handler here, or a handler
 * whose request or response doesn't match the map, fails the typecheck.
 */
export type Handlers = {
  readonly [C in CommandName]: (request: CommandRequest<C>) => CommandResponse<C> | Promise<CommandResponse<C>>
}

export interface HandlerContext {
  readonly db: Database
  readonly emit: Emit
}

export function createHandlers(context: HandlerContext): Handlers {
  const { db, emit } = context
  return {
    [CommandName.WorkspacesList]: () => ({ workspaces: listWorkspaces(db) }),
    [CommandName.TasksList]: ({ workspaceId }) => ({ tasks: listTasks(db, workspaceId) }),
    [CommandName.TasksCreate]: ({ workspaceId }) => ({ task: createTask(context, workspaceId) }),
    [CommandName.TasksMarkDone]: ({ id }) => ({ task: markTaskDone(context, id) }),
    [CommandName.TasksReopen]: ({ id }) => ({ task: reopenTask(context, id) }),
    [CommandName.TasksUpdate]: ({ id, patch }) => ({ task: updateTaskFromUser(context, id, patch) }),
    [CommandName.UiStateGet]: ({ key }) => ({ value: getUiState(db, key) ?? null }),
    [CommandName.UiStateGetAll]: () => ({ entries: listUiState(db) }),
    [CommandName.UiStateSet]: (entry) => {
      setUiState(db, entry)
      emit({ type: EventType.UiStateChanged, entry })
      return null
    },
  }
}
