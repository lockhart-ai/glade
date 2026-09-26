/**
 * A task's artifacts: the files the agent declares as its deliverables with `add_artifact`, shown in the Artifacts tab.
 * They're kept in the database with the task, so a done task still has them, and so does a relaunch. So is when each
 * one's file last changed, which the tab lists them by (#307): looked at as each is declared, and again whenever it may
 * have changed (`./artifact-watch`). A file that's gone keeps its last known time, and shows as missing.
 */
import { stat } from 'node:fs/promises'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import type { Artifact } from '../../shared/domain'
import {
  addArtifact,
  listArtifacts,
  removeArtifact,
  setArtifactFile,
  type ArtifactFileState,
} from '../db/repositories/artifacts'
import { CommandFailure } from '../bridge/errors'
import { resolveWorkspaceFile, toolFilePath, workspaceRoot } from '../files/files'
import type { TaskServiceContext } from '../tasks/service'

/**
 * What an artifact's file (relative to the workspace root) is now: when it last changed, or gone: nothing there, a
 * folder, or a path that now leads outside the workspace.
 */
export async function lookAtArtifactFile(rootPath: string, path: string): Promise<ArtifactFileState> {
  try {
    const real = await resolveWorkspaceFile(rootPath, path)
    if (real === null) return { missing: true }
    const info = await stat(real)
    return info.isFile() ? { missing: false, modifiedAt: info.mtimeMs } : { missing: true }
  } catch {
    return { missing: true }
  }
}

/**
 * Looks at the files of a task's artifacts again (those at `paths`, or every one), records what changed, and broadcasts
 * `artifacts.changed` when anything did. Answers whether anything did. A task that's gone changes nothing.
 */
export async function refreshTaskArtifacts(
  context: TaskServiceContext,
  taskId: string,
  paths?: readonly string[],
): Promise<boolean> {
  let root: string
  try {
    root = workspaceRoot(context, taskId)
  } catch {
    return false
  }
  const wanted = paths === undefined ? null : new Set(paths)
  const artifacts = listArtifacts(context.db, taskId).filter(({ path }) => wanted === null || wanted.has(path))
  const seen = await Promise.all(
    artifacts.map(async ({ path }) => ({ path, file: await lookAtArtifactFile(root, path) })),
  )
  let changed = false
  for (const { path, file } of seen) changed = setArtifactFile(context.db, { taskId, path, file }) || changed
  if (changed) context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(context.db, taskId) })
  return changed
}

/**
 * The agent's `add_artifact`: declares a file of the task's workspace as a deliverable, called `title`, notes when the
 * file last changed, and broadcasts `artifacts.changed`. `path` is absolute, or relative to the workspace root;
 * declaring a path again renames it. Answers with the artifact. Throws an `Error`, for the tool to tell the model, when
 * the path isn't a file inside the workspace.
 */
export async function addTaskArtifact(
  context: TaskServiceContext,
  taskId: string,
  path: string,
  title: string,
): Promise<Artifact> {
  const relativePath = await toolFilePath(context, taskId, path)
  const file = await lookAtArtifactFile(workspaceRoot(context, taskId), relativePath)
  const declared = addArtifact(context.db, { taskId, path: relativePath, title })
  setArtifactFile(context.db, { taskId, path: relativePath, file })
  const artifacts = listArtifacts(context.db, taskId)
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts })
  return artifacts.find((artifact) => artifact.path === relativePath) ?? declared
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
