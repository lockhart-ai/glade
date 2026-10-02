/**
 * What backfilling a past task through the control API checks (`docs/control-api.md`, "Backfilling past tasks"): the
 * files and links it registers as the task's artifacts (and, with `update_task`, those it changes or takes off). Its
 * dates are read in `./dates`.
 */
import { basename, isAbsolute } from 'node:path'
import { checkArtifactUrl, defaultLinkTitle } from '../../shared/artifactLinks'
import { artifactKey } from '../../shared/artifacts'
import { ArtifactKind, type Artifact, type ArtifactRef } from '../../shared/domain'
import { workspaceRelativePath } from '../../shared/files'
import { workspaceFilePath } from '../files/files'
import { ControlError, ControlErrorCode } from './errors'

/**
 * An artifact to register: a file by its absolute `path`, or a link by its `url` (#407), one of the two, and what to
 * call it (a file's name, or `defaultLinkTitle`'s for a link, if not).
 */
export interface ArtifactRegistration {
  readonly path?: string
  readonly url?: string
  readonly title?: string
}

/** A registered artifact, checked: a file by its path relative to the workspace root, or a link by its normalised URL. */
export type CheckedArtifact = ArtifactRef & { readonly title: string }

/** Refuses an input as `invalid_input`, naming the field. */
function refusal(field: string, reason: string): ControlError {
  return new ControlError(ControlErrorCode.InvalidInput, `${field}: ${reason}`)
}

/** A URL given for a link artifact, normalised; throws `invalid_input`, naming `field`, for one that can't be one. */
function checkedUrl(url: string, field: string): string {
  const check = checkArtifactUrl(url)
  if (!check.ok) throw refusal(field, check.reason)
  return check.url
}

/** A file to register, by an absolute path, as a path relative to the workspace at `root`; throws `invalid_input`. */
async function checkedFile(root: string, path: string, field: string): Promise<string> {
  if (!isAbsolute(path)) throw refusal(field, `${path} isn't an absolute path`)
  try {
    return await workspaceFilePath(root, path)
  } catch (error) {
    throw refusal(field, error instanceof Error ? error.message : String(error))
  }
}

/**
 * The artifacts to register, checked against the workspace at `root`: each file an absolute path to a file inside it,
 * each link a whole `http:` or `https:` URL. Throws `invalid_input` for the first that isn't, naming it by `field`
 * (e.g. `artifacts.1.path: …` or `artifacts.0.url: …`) and saying why. The tool's schema has already made sure each
 * gives one of `path` and `url`.
 */
export async function checkArtifacts(
  root: string,
  registrations: readonly ArtifactRegistration[],
  field: string,
): Promise<CheckedArtifact[]> {
  const checked: CheckedArtifact[] = []
  for (const [index, { path, url, title }] of registrations.entries()) {
    const at = `${field}.${String(index)}`
    if (url !== undefined) {
      const normalised = checkedUrl(url, `${at}.url`)
      checked.push({ kind: ArtifactKind.Link, url: normalised, title: title ?? defaultLinkTitle(normalised) })
      continue
    }
    const given = path ?? ''
    const relative = await checkedFile(root, given, `${at}.path`)
    checked.push({ kind: ArtifactKind.File, path: relative, title: title ?? basename(given) })
  }
  return checked
}

/**
 * A change to one of a task's artifacts (`update_task`'s `patch.updateArtifacts`): a file by its absolute `path`, to
 * point at `newPath`, or a link by its `url`, to point at `newUrl` (#407); a new title for either.
 */
export interface ArtifactUpdateRequest {
  /** A file artifact, by its file's absolute path. */
  readonly path?: string
  /** A link artifact, by its URL. */
  readonly url?: string
  readonly title?: string
  /** The file it's to point to instead, by absolute path. */
  readonly newPath?: string
  /** The page it's to point to instead. */
  readonly newUrl?: string
}

/** A change to one of a task's artifacts, checked: which it is, which it's to be, and what it came as. */
export interface CheckedArtifactUpdate {
  readonly ref: ArtifactRef
  /** It, unchanged, when no new path or URL was given. */
  readonly newRef: ArtifactRef
  readonly title?: string
  /** What it came as, to name it in an error. */
  readonly given: ArtifactUpdateRequest
}

/** A path under the workspace at `root`, relative to it, by the text alone: the file needn't be there. */
function relativeTo(root: string, path: string, field: string): string {
  const relative = workspaceRelativePath(path, root)
  if (relative === null) throw refusal(field, `${path} is outside the workspace (${root})`)
  return relative
}

/**
 * The artifact changes to make, checked against the workspace at `root`: each file's `path` inside it (its file
 * needn't be there), each `newPath` an absolute path to a file inside it, as `checkArtifacts` checks one, and each
 * link's `url` and `newUrl` a whole `http:` or `https:` URL. Throws `invalid_input` for the first that isn't, naming it
 * by `field` (e.g. `patch.updateArtifacts.0.newPath: …`). Whether each is one of the task's artifacts is
 * `planArtifactChanges`'s to check. The tool's schema has already made sure each names a file or a link, not both,
 * and gives a new path only to a file and a new URL only to a link.
 */
export async function checkArtifactUpdates(
  root: string,
  updates: readonly ArtifactUpdateRequest[],
  field: string,
): Promise<CheckedArtifactUpdate[]> {
  const checked: CheckedArtifactUpdate[] = []
  for (const [index, update] of updates.entries()) {
    const at = `${field}.${String(index)}`
    const title = update.title === undefined ? {} : { title: update.title }
    if (update.url !== undefined) {
      const ref: ArtifactRef = { kind: ArtifactKind.Link, url: checkedUrl(update.url, `${at}.url`) }
      const newRef: ArtifactRef =
        update.newUrl === undefined ? ref : { kind: ArtifactKind.Link, url: checkedUrl(update.newUrl, `${at}.newUrl`) }
      checked.push({ ref, newRef, ...title, given: update })
      continue
    }
    const ref: ArtifactRef = { kind: ArtifactKind.File, path: relativeTo(root, update.path ?? '', `${at}.path`) }
    const newRef: ArtifactRef =
      update.newPath === undefined
        ? ref
        : { kind: ArtifactKind.File, path: await checkedFile(root, update.newPath, `${at}.newPath`) }
    checked.push({ ref, newRef, ...title, given: update })
  }
  return checked
}

/**
 * The artifacts to take off (`patch.removeArtifacts`): files by absolute path, as paths relative to the workspace
 * root, and links by URL (#407), normalised. The tool's schema has already made sure each is an absolute path or an
 * `http:` or `https:` address.
 */
export function checkArtifactRemovals(root: string, given: readonly string[], field: string): ArtifactRef[] {
  return given.map((path, index) => {
    const at = `${field}.${String(index)}`
    return isAbsolute(path)
      ? { kind: ArtifactKind.File, path: relativeTo(root, path, at) }
      : { kind: ArtifactKind.Link, url: checkedUrl(path, at) }
  })
}

/** One change `planArtifactChanges` found to make: which artifact, which it's to be, and its title. */
export interface PlannedArtifactChange {
  readonly ref: ArtifactRef
  readonly newRef: ArtifactRef
  readonly title: string
}

/** What `planArtifactChanges` found to do: the artifacts to take off, then those to change, in order. */
export interface ArtifactChangePlan {
  readonly removals: readonly ArtifactRef[]
  readonly changes: readonly PlannedArtifactChange[]
}

/** How an error names what a change was given: a file by its path, a link by its URL. */
function givenName(given: ArtifactUpdateRequest, which: 'old' | 'new'): string {
  const name = which === 'old' ? (given.url ?? given.path) : (given.newUrl ?? given.newPath)
  return String(name)
}

/**
 * Plans a patch's artifact changes against the task's artifacts now (`current`): the removals first, then the changes,
 * each against the list as the ones before it leave it. Throws `invalid_input`, naming the field, for a removal or a
 * change of an artifact that isn't one of them then, and for a change to a new path or URL that already is.
 */
export function planArtifactChanges(
  current: readonly Artifact[],
  removals: readonly ArtifactRef[],
  updates: readonly CheckedArtifactUpdate[],
  fields: { readonly removals: string; readonly updates: string },
): ArtifactChangePlan {
  const titles = new Map(current.map((artifact) => [artifactKey(artifact), artifact.title]))
  for (const [index, ref] of removals.entries()) {
    if (!titles.delete(artifactKey(ref))) {
      const name = ref.kind === ArtifactKind.File ? ref.path : ref.url
      throw refusal(`${fields.removals}.${String(index)}`, `${name} isn't one of the task's artifacts`)
    }
  }
  const changes = updates.map(({ ref, newRef, title, given }, index): PlannedArtifactChange => {
    const at = `${fields.updates}.${String(index)}`
    const [key, newKey] = [artifactKey(ref), artifactKey(newRef)]
    const was = titles.get(key)
    if (was === undefined) {
      throw refusal(`${at}.${ref.kind === ArtifactKind.File ? 'path' : 'url'}`, `${givenName(given, 'old')} isn't one of the task's artifacts`)
    }
    if (newKey !== key && titles.has(newKey)) {
      throw refusal(
        `${at}.${newRef.kind === ArtifactKind.File ? 'newPath' : 'newUrl'}`,
        `${givenName(given, 'new')} is already one of the task's artifacts`,
      )
    }
    titles.delete(key)
    titles.set(newKey, title ?? was)
    return { ref, newRef, title: title ?? was }
  })
  return { removals, changes }
}
