/** The plugin feed's snapshot, read from SQLite. */
import type { Database } from 'better-sqlite3'
import { TaskState } from '../../shared/domain'
import { listOpenPermissionRequests } from '../db/repositories/permission-requests'
import { listOpenQuestionSets } from '../db/repositories/question-sets'
import { listActiveTasks } from '../db/repositories/tasks'
import { listToolEvents } from '../db/repositories/tool-events'
import { listWorkspaces } from '../db/repositories/workspaces'
import type { PluginFeedSource } from './feed'

export function databaseFeedSource(db: Database): PluginFeedSource {
  return {
    workspaces: () => listWorkspaces(db),
    // The task list's active section holds pinned done tasks too; a plugin's snapshot doesn't.
    activeTasks: () =>
      listWorkspaces(db).flatMap((workspace) =>
        listActiveTasks(db, workspace.id).filter((task) => task.state === TaskState.Active),
      ),
    toolEvents: (taskId) => listToolEvents(db, taskId),
    openQuestionSets: () => listOpenQuestionSets(db),
    openPermissionRequests: (taskId) => listOpenPermissionRequests(db, taskId),
  }
}
