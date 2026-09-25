/**
 * What backfilling a past task through the control API checks (`docs/control-api.md`, "Backfilling past tasks"): the
 * files it registers as the task's artifacts, and the date it says the task started.
 */
import { basename, isAbsolute } from 'node:path'
import type { EpochMs } from '../../shared/domain'
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

/** When a backfilled task started, from its ISO 8601 date: `invalid_input` when that's after `now`. */
export function startedAt(iso: string, now: EpochMs): EpochMs {
  const at = Date.parse(iso)
  if (at > now) throw new ControlError(ControlErrorCode.InvalidInput, `startedAt: ${iso} is in the future`)
  return at
}
