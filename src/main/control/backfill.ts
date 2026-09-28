/**
 * What backfilling a past task through the control API checks (`docs/control-api.md`, "Backfilling past tasks"): the
 * files it registers as the task's artifacts (and, with `update_task`, those it changes or takes off), and the date it
 * says the task started.
 */
import { basename, isAbsolute } from 'node:path'
import type { Artifact, EpochMs } from '../../shared/domain'
import { workspaceRelativePath } from '../../shared/files'
import { workspaceFilePath } from '../files/files'
import { ControlError, ControlErrorCode } from './errors'

/** A file to register as one of a task's artifacts: its absolute path, and what to call it (its file name if not). */
export interface ArtifactRegistration {
  readonly path: string
  readonly title?: string
}

/** A registered file, checked: its path relative to the workspace root, and its title. */
export interface CheckedArtifact {
  readonly path: string
  readonly title: string
}

/**
 * The files to register, checked against the workspace at `root`: each must be an absolute path to a file inside it.
 * Throws `invalid_input` for the first that isn't, naming it by `field` (e.g. `artifacts.1.path: …`) and saying why.
 */
export async function checkArtifacts(
  root: string,
  registrations: readonly ArtifactRegistration[],
  field: string,
): Promise<CheckedArtifact[]> {
  const checked: CheckedArtifact[] = []
  for (const [index, { path, title }] of registrations.entries()) {
    const refuse = (reason: string): ControlError =>
      new ControlError(ControlErrorCode.InvalidInput, `${field}.${String(index)}.path: ${reason}`)
    if (!isAbsolute(path)) throw refuse(`${path} isn't an absolute path`)
    let relative: string
    try {
      relative = await workspaceFilePath(root, path)
    } catch (error) {
      throw refuse(error instanceof Error ? error.message : String(error))
    }
    checked.push({ path: relative, title: title ?? basename(path) })
  }
  return checked
}

/** A change to one of a task's artifacts (`update_task`'s `patch.updateArtifacts`): by absolute paths. */
export interface ArtifactUpdateRequest {
  /** The artifact, by its file's absolute path. */
  readonly path: string
  readonly title?: string
  /** The file it's to point to instead, by absolute path. */
  readonly newPath?: string
}

/** A change to one of a task's artifacts, checked: its paths relative to the workspace root, and what it came as. */
export interface CheckedArtifactUpdate {
  readonly path: string
  /** Its path unchanged when no new one was given. */
  readonly newPath: string
  readonly title?: string
  /** What the new path was given as, to name it in an error. */
  readonly given: ArtifactUpdateRequest
}

/** A path under the workspace at `root`, relative to it, by the text alone: the file needn't be there. */
function relativeTo(root: string, path: string, refuse: (reason: string) => ControlError): string {
  const relative = workspaceRelativePath(path, root)
  if (relative === null) throw refuse(`${path} is outside the workspace (${root})`)
  return relative
}

/**
 * The artifact changes to make, checked against the workspace at `root`: each `path` inside it (its file needn't be
 * there), each `newPath` an absolute path to a file inside it, as `checkArtifacts` checks one. Throws `invalid_input` for
 * the first that isn't, naming it by `field` (e.g. `patch.updateArtifacts.0.newPath: …`). Whether each is one of the
 * task's artifacts is `planArtifactChanges`'s to check.
 */
export async function checkArtifactUpdates(
  root: string,
  updates: readonly ArtifactUpdateRequest[],
  field: string,
): Promise<CheckedArtifactUpdate[]> {
  const checked: CheckedArtifactUpdate[] = []
  for (const [index, update] of updates.entries()) {
    const refuse =
      (key: string) =>
      (reason: string): ControlError =>
        new ControlError(ControlErrorCode.InvalidInput, `${field}.${String(index)}.${key}: ${reason}`)
    const path = relativeTo(root, update.path, refuse('path'))
    let newPath = path
    if (update.newPath !== undefined) {
      try {
        newPath = await workspaceFilePath(root, update.newPath)
      } catch (error) {
        throw refuse('newPath')(error instanceof Error ? error.message : String(error))
      }
    }
    checked.push({ path, newPath, ...(update.title === undefined ? {} : { title: update.title }), given: update })
  }
  return checked
}

/** The artifacts to take off (`patch.removeArtifacts`), by absolute path, as paths relative to the workspace root. */
export function checkArtifactRemovals(root: string, paths: readonly string[], field: string): string[] {
  return paths.map((path, index) =>
    relativeTo(
      root,
      path,
      (reason) => new ControlError(ControlErrorCode.InvalidInput, `${field}.${String(index)}: ${reason}`),
    ),
  )
}

/** What `planArtifactChanges` found to do: the artifacts to take off, then those to change, in order. */
export interface ArtifactChangePlan {
  readonly removals: readonly string[]
  readonly changes: readonly { readonly path: string; readonly newPath: string; readonly title: string }[]
}

/**
 * Plans a patch's artifact changes against the task's artifacts now (`current`): the removals first, then the changes,
 * each against the list as the ones before it leave it. Throws `invalid_input`, naming the field, for a removal or a
 * change of a path that isn't one of them then, and for a change to a new path that already is.
 */
export function planArtifactChanges(
  current: readonly Pick<Artifact, 'path' | 'title'>[],
  removals: readonly string[],
  updates: readonly CheckedArtifactUpdate[],
  fields: { readonly removals: string; readonly updates: string },
): ArtifactChangePlan {
  const titles = new Map(current.map(({ path, title }) => [path, title]))
  const refuse = (field: string, reason: string): ControlError =>
    new ControlError(ControlErrorCode.InvalidInput, `${field}: ${reason}`)
  for (const [index, path] of removals.entries()) {
    if (!titles.delete(path)) {
      throw refuse(`${fields.removals}.${String(index)}`, `${path} isn't one of the task's artifacts`)
    }
  }
  const changes = updates.map(({ path, newPath, title, given }, index) => {
    const was = titles.get(path)
    if (was === undefined) {
      throw refuse(`${fields.updates}.${String(index)}.path`, `${given.path} isn't one of the task's artifacts`)
    }
    if (newPath !== path && titles.has(newPath)) {
      throw refuse(
        `${fields.updates}.${String(index)}.newPath`,
        `${String(given.newPath)} is already one of the task's artifacts`,
      )
    }
    titles.delete(path)
    titles.set(newPath, title ?? was)
    return { path, newPath, title: title ?? was }
  })
  return { removals, changes }
}

/** When a backfilled task started, from its ISO 8601 date: `invalid_input` when that's after `now`. */
export function startedAt(iso: string, now: EpochMs): EpochMs {
  const at = Date.parse(iso)
  if (at > now) throw new ControlError(ControlErrorCode.InvalidInput, `startedAt: ${iso} is in the future`)
  return at
}
