/**
 * What the image viewer (`ImageViewer.tsx`) can show: a message's pasted image, loaded from main by id (`images.get`),
 * or a task's workspace file, loaded whole from main by path (`files.read`) as a `data:` URL. The Artifacts tab opens
 * the viewer on its image artifacts, in the list's order; the Files tab opens it on the one file showing.
 */
import type { ImageRef } from '../../shared/images'

/** Which kind of image source the viewer shows. */
export enum ImageSourceKind {
  Pasted = 'pasted',
  Workspace = 'workspace',
}

/** A message's pasted image. */
export interface PastedImageSource {
  readonly kind: ImageSourceKind.Pasted
  readonly ref: ImageRef
}

/** A file in a task's workspace: an artifact, or the file showing in the Files tab. */
export interface WorkspaceImageSource {
  readonly kind: ImageSourceKind.Workspace
  readonly taskId: string
  /** Relative to the workspace root. */
  readonly path: string
  /** What the header shows over it: an artifact's title, or the file's name. */
  readonly title: string
}

/** One of the images the image viewer can show. */
export type ImageViewerSource = PastedImageSource | WorkspaceImageSource

export function pastedImageSource(ref: ImageRef): PastedImageSource {
  return { kind: ImageSourceKind.Pasted, ref }
}

export function workspaceImageSource(taskId: string, path: string, title: string): WorkspaceImageSource {
  return { kind: ImageSourceKind.Workspace, taskId, path, title }
}

/** What tells two image sources apart, for a list's `key` and to know when the viewer is asked to show the same image again. */
export function imageSourceKey(source: ImageViewerSource): string {
  switch (source.kind) {
    case ImageSourceKind.Pasted:
      return `pasted:${source.ref.id}`
    case ImageSourceKind.Workspace:
      return `workspace:${source.taskId}:${source.path}`
  }
}
