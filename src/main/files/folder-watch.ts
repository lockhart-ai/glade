/**
 * Keeps the Browse tab's tree live (#398): while it shows a task, the folders it shows open (and the root) are watched
 * (`fs.watch`, one folder at a time, never recursively), so a file the agent makes or deletes, or anything else does,
 * shows at once. A change says which folder changed (`files.folderChanged`); the window lists that folder again.
 * Changes close together are told once: the first starts a short wait, and every folder changed during it is told when
 * it ends.
 */
import { EventType } from '../../shared/bridge'
import { watchFolderWithFs, type FolderWatch, type WatchFolder } from '../artifacts/artifact-watch'
import type { TaskServiceContext } from '../tasks/service'
import { resolveWorkspaceFile, workspaceRoot } from './files'

/** How long a change waits for others before the folders it names are told of, in milliseconds. */
export const FOLDER_CHANGE_WAIT_MS = 150

export interface FolderWatcherOptions {
  readonly context: TaskServiceContext
  /** How folders are watched: `fs.watch` by default. */
  readonly watchFolder?: WatchFolder
  /** How long a change waits for others: `FOLDER_CHANGE_WAIT_MS` by default. */
  readonly waitMs?: number
}

export interface FolderWatcher {
  /**
   * Watches these folders of a task's workspace (`''` for the root), and no others of it: the folders the Browse tab
   * shows open (`files.watchFolders`). None stops watching the task. A folder that isn't there, or leads outside the
   * root, isn't watched.
   */
  watch(taskId: string, paths: readonly string[]): Promise<void>
  /** Stops watching everything, and drops the changes waiting to be told (the app is quitting). */
  close(): void
}

export function createFolderWatcher({
  context,
  watchFolder = watchFolderWithFs,
  waitMs = FOLDER_CHANGE_WAIT_MS,
}: FolderWatcherOptions): FolderWatcher {
  // Each task's watched folders, by path, and the order its requests came in: only the latest one counts.
  const watched = new Map<string, Map<string, FolderWatch>>()
  const requests = new Map<string, number>()
  // The folders changed while a change waits for others, by task, and the wait.
  const waiting = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>()

  const changed = (taskId: string, path: string): void => {
    const pending = waiting.get(taskId)
    if (pending !== undefined) {
      pending.paths.add(path)
      return
    }
    const paths = new Set([path])
    const timer = setTimeout(() => {
      waiting.delete(taskId)
      for (const changedPath of paths) context.emit({ type: EventType.FolderChanged, taskId, path: changedPath })
    }, waitMs)
    waiting.set(taskId, { paths, timer })
  }

  /** The real folder a path of the task's workspace is; null when it isn't one, or leads outside the root. */
  const folderOf = async (root: string, path: string): Promise<string | null> => {
    try {
      return await resolveWorkspaceFile(root, path)
    } catch {
      return null
    }
  }

  const stop = (taskId: string): void => {
    for (const folderWatch of watched.get(taskId)?.values() ?? []) folderWatch.close()
    watched.delete(taskId)
    const pending = waiting.get(taskId)
    if (pending !== undefined) clearTimeout(pending.timer)
    waiting.delete(taskId)
  }

  return {
    async watch(taskId, paths) {
      const request = (requests.get(taskId) ?? 0) + 1
      requests.set(taskId, request)
      if (paths.length === 0) {
        stop(taskId)
        return
      }
      const root = workspaceRoot(context, taskId)
      const wanted = new Set(paths)
      const folders = watched.get(taskId) ?? new Map<string, FolderWatch>()
      for (const [path, folderWatch] of folders) {
        if (wanted.has(path)) continue
        folderWatch.close()
        folders.delete(path)
      }
      watched.set(taskId, folders)
      for (const path of wanted) {
        if (folders.has(path)) continue
        const real = await folderOf(root, path)
        // A newer request came while this one looked: it decides what's watched.
        if (requests.get(taskId) !== request) return
        if (real === null) continue
        try {
          folders.set(
            path,
            watchFolder(real, () => {
              changed(taskId, path)
            }),
          )
        } catch {
          // A folder that went (or is a file) can't be watched: its parent's change shows it went.
        }
      }
    },

    close() {
      for (const taskId of [...watched.keys()]) stop(taskId)
      for (const { timer } of waiting.values()) clearTimeout(timer)
      waiting.clear()
    },
  }
}
