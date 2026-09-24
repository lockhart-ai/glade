/**
 * A task's artifacts: the files the agent declares as its deliverables with `add_artifact`, shown in the Artifacts tab.
 * They're kept in the database with the task, so a done task still has them, and so does a relaunch.
 */
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import type { Artifact } from '../../shared/domain'
import { addArtifact, listArtifacts, removeArtifact } from '../db/repositories/artifacts'
import { CommandFailure } from '../bridge/errors'
import { toolFilePath } from '../files/files'
import type { TaskServiceContext } from '../tasks/service'

/**
 * The agent's `add_artifact`: declares a file of the task's workspace as a deliverable, called `title`, and broadcasts
 * `artifacts.changed`. `path` is absolute, or relative to the workspace root; declaring a path again renames it. Answers
 * with the artifact. Throws an `Error`, for the tool to tell the model, when the path isn't a file inside the workspace.
 */
export async function addTaskArtifact(
  context: TaskServiceContext,
  taskId: string,
  path: string,
  title: string,
): Promise<Artifact> {
  const relativePath = await toolFilePath(context, taskId, path)
  const artifact = addArtifact(context.db, { taskId, path: relativePath, title })
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(context.db, taskId) })
  return artifact
}

/**
 * `artifacts.remove` (Remove from artifacts): takes a file off the task's artifacts, leaving the file itself alone, and
 * broadcasts `artifacts.changed`. Throws a `CommandFailure` `not_found` when it isn't one of them.
 */
export function removeTaskArtifact(context: TaskServiceContext, taskId: string, path: string): void {
  if (!removeArtifact(context.db, taskId, path)) {
    throw new CommandFailure(BridgeErrorCode.NotFound, `${path} isn't one of task ${taskId}'s artifacts`)
  }
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(context.db, taskId) })
}
