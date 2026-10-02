/** Naming a task's artifacts, whatever their kind (#407): a file by its path, a link by its normalised URL. */
import { ArtifactKind, type Artifact, type ArtifactRef } from './domain'

/** An artifact's ref (`ArtifactRef`): what names it to main. */
export function artifactRef(artifact: Artifact): ArtifactRef {
  switch (artifact.kind) {
    case ArtifactKind.File:
      return { kind: ArtifactKind.File, path: artifact.path }
    case ArtifactKind.Link:
      return { kind: ArtifactKind.Link, url: artifact.url }
  }
}

/**
 * One string naming an artifact among a task's, whatever its kind: `file:<path>` or `link:<url>`, so a file and a link
 * can never be taken for each other.
 */
export function artifactKey(artifact: Artifact | ArtifactRef): string {
  switch (artifact.kind) {
    case ArtifactKind.File:
      return `file:${artifact.path}`
    case ArtifactKind.Link:
      return `link:${artifact.url}`
  }
}

/** A task's file artifacts, in the order given. */
export function fileArtifacts(artifacts: readonly Artifact[]): Extract<Artifact, { kind: ArtifactKind.File }>[] {
  return artifacts.flatMap((artifact) => (artifact.kind === ArtifactKind.File ? [artifact] : []))
}
