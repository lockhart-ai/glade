/**
 * A task's artifacts: the files the agent declares as its deliverables with `add_artifact` (and renames, repoints or
 * takes off with `update_artifact` and `remove_artifact`), shown as tiles in the Todos tab, and the links it declares the
 * same way (#407): the PRs, issues and tickets the task is about, by URL, which you can add by hand too. They're kept in
 * the database with the task, so a done task still has them, and so does a relaunch. So is when each file last changed,
 * which the tab lists them by (#307): looked at as each is declared, and again whenever it may have changed
 * (`./artifact-watch`). A file that's gone keeps its last known time, and shows as missing.
 *
 * With the todo hub on (P16, `../todo-hub`), an artifact can be filed under a todo, and its filing is kept in step
 * here, however the artifact changes: one pointed at another file or page keeps its todo, and one that's removed
 * leaves no filing behind.
 */
import { stat } from 'node:fs/promises'
import { checkArtifactUrl, defaultLinkTitle } from '../../shared/artifactLinks'
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import {
  ArtifactKind,
  type Artifact,
  type ArtifactRef,
  type FileArtifact,
  type LinkArtifact,
} from '../../shared/domain'
import { workspaceRelativePath } from '../../shared/files'
import { ChildKind, childOfArtifact } from '../../shared/todoHub'
import {
  addArtifact,
  addLinkArtifact,
  changeArtifact,
  changeLinkArtifact,
  getArtifact,
  listArtifacts,
  listFileArtifacts,
  removeArtifact,
  setArtifactFile,
  type ArtifactFileState,
} from '../db/repositories/artifacts'
import { CommandFailure } from '../bridge/errors'
import { resolveWorkspaceFile, toolFilePath, workspaceRoot } from '../files/files'
import { requireTask, type TaskServiceContext } from '../tasks/service'
import { refileChild, unfileChildren } from '../todo-hub/todo-hub'

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
 * `artifacts.changed` when anything did. Answers whether anything did. A task that's gone changes nothing. Its links
 * have no file to look at.
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
  const artifacts = listFileArtifacts(context.db, taskId).filter(({ path }) => wanted === null || wanted.has(path))
  const seen = await Promise.all(
    artifacts.map(async ({ path }) => ({ path, file: await lookAtArtifactFile(root, path) })),
  )
  let changed = false
  for (const { path, file } of seen) changed = setArtifactFile(context.db, { taskId, path, file }) || changed
  if (changed) context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(context.db, taskId) })
  return changed
}

/** One of a task's file artifacts, as it now is; undefined when it isn't one. */
function fileArtifact(context: TaskServiceContext, taskId: string, path: string): FileArtifact | undefined {
  const artifact = getArtifact(context.db, taskId, { kind: ArtifactKind.File, path })
  return artifact?.kind === ArtifactKind.File ? artifact : undefined
}

/** One of a task's link artifacts, as it now is; undefined when it isn't one. */
function linkArtifact(context: TaskServiceContext, taskId: string, url: string): LinkArtifact | undefined {
  const artifact = getArtifact(context.db, taskId, { kind: ArtifactKind.Link, url })
  return artifact?.kind === ArtifactKind.Link ? artifact : undefined
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
): Promise<FileArtifact> {
  const relativePath = await toolFilePath(context, taskId, path)
  const file = await lookAtArtifactFile(workspaceRoot(context, taskId), relativePath)
  const declared = addArtifact(context.db, { taskId, path: relativePath, title })
  setArtifactFile(context.db, { taskId, path: relativePath, file })
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(context.db, taskId) })
  return fileArtifact(context, taskId, relativePath) ?? declared
}

/** A URL a tool gives for a link artifact, normalised (`checkArtifactUrl`); throws an `Error` saying why it can't be one. */
export function artifactUrl(raw: string): string {
  const check = checkArtifactUrl(raw)
  if (!check.ok) throw new Error(`The url ${check.reason}.`)
  return check.url
}

/**
 * The agent's `add_artifact` with a `url` (#407): declares a link (a PR, an issue, a ticket, any web page) as one of
 * the task's artifacts, called `title`, keyed by its normalised URL, and broadcasts `artifacts.changed`. Declaring the
 * same URL again renames it. Answers with the artifact. Throws an `Error`, for the tool to tell the model, when the URL
 * isn't a whole `http:` or `https:` one (`checkArtifactUrl`), and a `CommandFailure` `not_found` when the task is gone.
 */
export function addTaskLinkArtifact(
  context: TaskServiceContext,
  taskId: string,
  url: string,
  title: string,
): LinkArtifact {
  const normalised = artifactUrl(url)
  requireTask(context.db, taskId)
  const artifact = addLinkArtifact(context.db, { taskId, url: normalised, title })
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(context.db, taskId) })
  return artifact
}

/** What `artifacts.addLink` (Add to artifacts, on a link) adds: its address, and what the link says. */
export interface LinkArtifactRequest {
  readonly url: string
  /** What the link says: its address, or nothing, when it says nothing else. */
  readonly text: string
}

/**
 * `artifacts.addLink` (Add to artifacts, on a link): adds a link you right-clicked to the task's artifacts, called what
 * it says, or `#412` or `API-123` for a bare PR, issue or ticket link (`defaultLinkTitle`), and broadcasts
 * `artifacts.changed`. A link that's already one of them stays as it is, title and all. Fails with `invalid_request`
 * for an address that can't be an artifact, and `not_found` for a task that's gone.
 */
export function addTaskLinkByHand(
  context: TaskServiceContext,
  taskId: string,
  { url, text }: LinkArtifactRequest,
): LinkArtifact {
  const check = checkArtifactUrl(url)
  if (!check.ok) throw new CommandFailure(BridgeErrorCode.InvalidRequest, `That link ${check.reason}`)
  requireTask(context.db, taskId)
  return (
    linkArtifact(context, taskId, check.url) ??
    addTaskLinkArtifact(context, taskId, check.url, defaultLinkTitle(check.url, text))
  )
}

/**
 * One of a task's artifacts, by a path a tool gives: absolute, or relative to the workspace root. The file needn't be
 * there any more. Throws an `Error`, for the tool to tell the model, when the path is outside the workspace or isn't one
 * of the task's artifacts.
 */
function declaredArtifact(context: TaskServiceContext, taskId: string, path: string): FileArtifact {
  const root = workspaceRoot(context, taskId)
  const relativePath = workspaceRelativePath(path, root)
  if (relativePath === null) throw new Error(`${path} is outside the workspace (${root}).`)
  const artifact = fileArtifact(context, taskId, relativePath)
  if (artifact === undefined) throw new Error(`${relativePath} isn't one of this task's artifacts.`)
  return artifact
}

/**
 * One of a task's link artifacts, by a URL a tool gives (normalised as `add_artifact` normalises one). Throws an
 * `Error`, for the tool to tell the model, when it isn't one, and a `CommandFailure` `not_found` when the task is gone.
 */
function declaredLink(context: TaskServiceContext, taskId: string, url: string): LinkArtifact {
  const normalised = artifactUrl(url)
  requireTask(context.db, taskId)
  const artifact = linkArtifact(context, taskId, normalised)
  if (artifact === undefined) throw new Error(`${normalised} isn't one of this task's artifacts.`)
  return artifact
}

/** What the agent's `update_artifact` changes: a new title, a new file, or both. */
export interface ArtifactUpdate {
  /** The artifact: absolute, or relative to the workspace root. */
  readonly path: string
  readonly title?: string | undefined
  /** The file it's to point to instead: absolute, or relative to the workspace root. */
  readonly newPath?: string | undefined
}

/** One of a task's artifacts, before and after a change. */
export interface UpdatedArtifact<T extends Artifact = Artifact> {
  readonly before: T
  readonly after: T
}

/**
 * The agent's `update_artifact`: renames one of the task's artifacts and/or points it at another file of the
 * workspace (checked as `add_artifact` checks a path), keeping its place, notes when its new file last changed, and
 * broadcasts `artifacts.changed`. A change to nothing (the same title and file) writes nothing and broadcasts nothing.
 * Answers with the artifact before and after. Throws an `Error`, for the tool to tell the model, when `path` isn't one of
 * its artifacts, `newPath` isn't a file inside the workspace, or `newPath` is another of its artifacts.
 */
export async function updateTaskArtifact(
  context: TaskServiceContext,
  taskId: string,
  { path, title, newPath }: ArtifactUpdate,
): Promise<UpdatedArtifact<FileArtifact>> {
  const { db } = context
  const found = declaredArtifact(context, taskId, path)
  const target = newPath === undefined ? found.path : await toolFilePath(context, taskId, newPath)
  const file = target === found.path ? null : await lookAtArtifactFile(workspaceRoot(context, taskId), target)
  // Looked at again after the file checks, which wait: the artifact may have gone, or its new path been declared.
  const before = declaredArtifact(context, taskId, found.path)
  const taken = target === before.path ? undefined : fileArtifact(context, taskId, target)
  if (taken !== undefined) {
    throw new Error(`${target} is already one of this task's artifacts ("${taken.title}"). Remove one of them first.`)
  }
  const nextTitle = title ?? before.title
  if (target === before.path && nextTitle === before.title) return { before, after: before }
  const changed = changeArtifact(db, { taskId, path: before.path, newPath: target, title: nextTitle }) ?? before
  if (file !== null) setArtifactFile(db, { taskId, path: target, file })
  refileChild(context, taskId, { kind: ChildKind.File, key: before.path }, { kind: ChildKind.File, key: target })
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(db, taskId) })
  return { before, after: fileArtifact(context, taskId, target) ?? changed }
}

/** What the agent's `update_artifact` changes of a link artifact (#407): a new title, a new URL, or both. */
export interface LinkArtifactUpdate {
  /** The artifact's URL, as it was added. */
  readonly url: string
  readonly title?: string | undefined
  /** The page it's to point to instead. */
  readonly newUrl?: string | undefined
}

/**
 * The agent's `update_artifact` for a link (#407): renames one of the task's link artifacts and/or points it at
 * another page (checked as `add_artifact` checks a URL), keeping its place, and broadcasts `artifacts.changed`. A change
 * to nothing writes and broadcasts nothing. Answers with the artifact before and after. Throws an `Error`, for the tool
 * to tell the model, when `url` isn't one of its artifacts, `newUrl` can't be one, or `newUrl` is another of them.
 */
export function updateTaskLinkArtifact(
  context: TaskServiceContext,
  taskId: string,
  { url, title, newUrl }: LinkArtifactUpdate,
): UpdatedArtifact<LinkArtifact> {
  const { db } = context
  const before = declaredLink(context, taskId, url)
  const target = newUrl === undefined ? before.url : artifactUrl(newUrl)
  const taken = target === before.url ? undefined : linkArtifact(context, taskId, target)
  if (taken !== undefined) {
    throw new Error(`${target} is already one of this task's artifacts ("${taken.title}"). Remove one of them first.`)
  }
  const nextTitle = title ?? before.title
  if (target === before.url && nextTitle === before.title) return { before, after: before }
  const after = changeLinkArtifact(db, { taskId, url: before.url, newUrl: target, title: nextTitle }) ?? before
  refileChild(context, taskId, { kind: ChildKind.Link, key: before.url }, { kind: ChildKind.Link, key: target })
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(db, taskId) })
  return { before, after }
}

/**
 * The agent's `remove_artifact`: takes one of the task's artifacts off its list, by a path absolute or relative to the
 * workspace root, leaving the file itself alone, and broadcasts `artifacts.changed`. Answers with the artifact removed.
 * Throws an `Error`, for the tool to tell the model, when the path isn't one of its artifacts.
 */
export function forgetTaskArtifact(context: TaskServiceContext, taskId: string, path: string): FileArtifact {
  const artifact = declaredArtifact(context, taskId, path)
  removeTaskArtifact(context, taskId, { kind: ArtifactKind.File, path: artifact.path })
  return artifact
}

/**
 * The agent's `remove_artifact` for a link (#407): takes one of the task's link artifacts off its list, by its URL, and
 * broadcasts `artifacts.changed`. Answers with the artifact removed. Throws an `Error`, for the tool to tell the model,
 * when the URL isn't one of its artifacts.
 */
export function forgetTaskLinkArtifact(context: TaskServiceContext, taskId: string, url: string): LinkArtifact {
  const artifact = declaredLink(context, taskId, url)
  removeTaskArtifact(context, taskId, { kind: ArtifactKind.Link, url: artifact.url })
  return artifact
}

/** How an error names an artifact: a file by its path, a link by its URL. */
function refName(ref: ArtifactRef): string {
  switch (ref.kind) {
    case ArtifactKind.File:
      return ref.path
    case ArtifactKind.Link:
      return ref.url
  }
}

/**
 * `artifacts.remove` (Remove from artifacts): takes a file or a link off the task's artifacts, leaving a file itself
 * alone, and broadcasts `artifacts.changed`. Its filing under a todo, if it had one, goes with it. Throws a
 * `CommandFailure` `not_found` when it isn't one of them.
 */
export function removeTaskArtifact(context: TaskServiceContext, taskId: string, ref: ArtifactRef): void {
  if (!removeArtifact(context.db, taskId, ref)) {
    throw new CommandFailure(BridgeErrorCode.NotFound, `${refName(ref)} isn't one of task ${taskId}'s artifacts`)
  }
  unfileChildren(context, taskId, [childOfArtifact(ref)])
  context.emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(context.db, taskId) })
}
