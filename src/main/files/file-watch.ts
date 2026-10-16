/**
 * Keeps the files open in the Files tab live (#646): each open file's folder is watched (`fs.watch`, one folder at a
 * time, never recursively, like the artifacts' and the Browse tab's folders), so a change from outside the agent — a
 * shell command, a script, git, another editor — is noticed like the agent's own edits are. A change says the file
 * changed (`files.fileChanged`), with how many times its watch has seen it change; the window reads the file again.
 * Watching the folder rather than the file follows an editor that saves by writing a new file over the old one, and a
 * file deleted and written again keeps its watch. Changes close together are told once: the first starts a short
 * wait, and every file changed during it is told of when it ends.
 *
 * What's watched follows what's open: the open files each event on its way to the windows names (`openFiles.changed`),
 * seeded with what each task already has open. A file as a commit left it is only in git: it isn't watched.
 */
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { parseCommitFileKey } from '../../shared/files'
import { watchFolderWithFs, type FolderWatch, type WatchFolder } from '../artifacts/artifact-watch'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { TaskServiceContext } from '../tasks/service'
import { resolveWorkspaceFile, workspaceFilesRoot, workspaceRoot } from './files'

/** How long a change waits for others before the files it names are told of, in milliseconds. */
export const FILE_CHANGE_WAIT_MS = 150

/** The most files watched at once, over every task: watches are cheap, but not free. */
export const MAX_OPEN_FILE_WATCHES = 100

export interface FileWatcherOptions {
  readonly context: TaskServiceContext
  /** How folders are watched: `fs.watch` by default. */
  readonly watchFolder?: WatchFolder
  /** How long a change waits for others: `FILE_CHANGE_WAIT_MS` by default. */
  readonly waitMs?: number
  readonly log?: Logger
}

export interface FileWatcher {
  /**
   * Watches these files open in the task's Files tab (relative to its workspace root), and no others of it. A file as
   * a commit left it, one that leads outside the root, and anything past the cap (`MAX_OPEN_FILE_WATCHES`) isn't
   * watched.
   */
  watch(taskId: string, paths: readonly string[]): Promise<void>
  /**
   * Hears every event on its way to the windows: what's open changing (to watch or stop watching), and a task going
   * (to drop its watches).
   */
  observe(event: GladeEvent): void
  /** Stops watching everything, and drops the changes waiting to be told (the app is quitting). */
  close(): void
}

/** A folder being watched for a task: the open files of its workspace whose folder it is, and the watch. */
interface WatchedFolder {
  readonly files: ReadonlySet<string>
  readonly watch: FolderWatch
}

/** Whether a workspace path is a plain one: every part of it is a name, so its folder is found where the root holds it. */
function isPlainPath(path: string): boolean {
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function createFileWatcher({
  context,
  watchFolder = watchFolderWithFs,
  waitMs = FILE_CHANGE_WAIT_MS,
  log = SILENT_LOGGER,
}: FileWatcherOptions): FileWatcher {
  // Each task's watched folders, by real folder; how many times each watched file has been seen to change, by path;
  // and the order its requests came in: only the latest one counts.
  const watched = new Map<string, Map<string, WatchedFolder>>()
  const versions = new Map<string, Map<string, number>>()
  const requests = new Map<string, number>()
  // The files changed while a change waits for others, by task, and the wait.
  const waiting = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>()

  /** Notes that files of a task may have changed, to be told of once the wait is over. */
  const changed = (taskId: string, paths: readonly string[]): void => {
    if (paths.length === 0) return
    const pending = waiting.get(taskId)
    if (pending !== undefined) {
      for (const path of paths) pending.paths.add(path)
      return
    }
    const waitingPaths = new Set(paths)
    const timer = setTimeout(() => {
      waiting.delete(taskId)
      const counters = versions.get(taskId)
      for (const path of waitingPaths) {
        // A file no longer open isn't told of: the flush is for what's watched as it ends.
        const previous = counters?.get(path)
        if (counters === undefined || previous === undefined) continue
        counters.set(path, previous + 1)
        context.emit({ type: EventType.FileChanged, taskId, path, version: previous + 1 })
      }
    }, waitMs)
    waiting.set(taskId, { paths: waitingPaths, timer })
  }

  /** A change in a watched folder: the open file it names in it, or all of them when it can't tell which file. */
  const folderChanged = (taskId: string, folder: string, fileName: string | null): void => {
    const entry = watched.get(taskId)?.get(folder)
    if (entry === undefined) return
    const paths = fileName === null ? [...entry.files] : [...entry.files].filter((path) => basename(path) === fileName)
    changed(taskId, paths)
  }

  /** The real folder the file at `path` of the workspace is in; null when it has none to watch. */
  const folderOf = async (root: string, path: string): Promise<string | null> => {
    try {
      const real = await resolveWorkspaceFile(root, path)
      if (real !== null) return dirname(real)
    } catch {
      // The path, or a symlink on it, leads outside the root: not the workspace's to watch.
      return null
    }
    // The file isn't there (any more): watch its folder all the same, so writing it again is noticed. A plain path's
    // folder is the root's own; one that isn't plain isn't trusted past the file it names being gone.
    if (!isPlainPath(path)) return null
    try {
      return await realpath(dirname(join(workspaceFilesRoot(root), path)))
    } catch {
      return null
    }
  }

  /** How many files are watched now, over every task. */
  const watchedFiles = (): number => {
    let total = 0
    for (const folders of watched.values()) for (const entry of folders.values()) total += entry.files.size
    return total
  }

  /** Stops watching everything of the task, and drops the changes of its waiting to be told. */
  const stop = (taskId: string): void => {
    for (const entry of watched.get(taskId)?.values() ?? []) entry.watch.close()
    watched.delete(taskId)
    versions.delete(taskId)
    requests.delete(taskId)
    const pending = waiting.get(taskId)
    if (pending !== undefined) clearTimeout(pending.timer)
    waiting.delete(taskId)
  }

  /** Watches these files open in the task's Files tab, and no others of it. */
  const watch = async (taskId: string, paths: readonly string[]): Promise<void> => {
    const request = (requests.get(taskId) ?? 0) + 1
    requests.set(taskId, request)
    const wanted = [...new Set(paths)].filter((path) => parseCommitFileKey(path) === null)
    let root: string
    try {
      root = workspaceRoot(context, taskId)
    } catch {
      // The task is gone (or was never there): nothing of it to watch.
      if (requests.get(taskId) === request) stop(taskId)
      return
    }
    // The folders to watch, and the open files each is watched for.
    const byFolder = new Map<string, Set<string>>()
    await Promise.all(
      wanted.map(async (path) => {
        const folder = await folderOf(root, path)
        if (folder === null) return
        byFolder.set(folder, (byFolder.get(folder) ?? new Set<string>()).add(path))
      }),
    )
    // A newer request came while this one looked: it decides what's watched.
    if (requests.get(taskId) !== request) return
    const folders = watched.get(taskId) ?? new Map<string, WatchedFolder>()
    watched.set(taskId, folders)
    for (const [folder, entry] of folders) {
      const files = byFolder.get(folder)
      if (files === undefined) {
        entry.watch.close()
        folders.delete(folder)
      } else {
        byFolder.delete(folder)
        folders.set(folder, { files, watch: entry.watch })
      }
    }
    // What's watched elsewhere counts against the cap too; what this sync just closed no longer does.
    let budget = MAX_OPEN_FILE_WATCHES - watchedFiles()
    let atCap = false
    for (const [folder, files] of byFolder) {
      if (budget < files.size) {
        atCap = true
        continue
      }
      try {
        folders.set(folder, {
          files,
          watch: watchFolder(folder, (fileName) => {
            folderChanged(taskId, folder, fileName)
          }),
        })
        budget -= files.size
      } catch (error) {
        // A folder that's gone can't be watched: the file shows as it was until something changes what's open.
        log.warn('an open file’s folder can’t be watched', { taskId, folder, error })
      }
    }
    if (atCap) log.warn('not watching some open files: at the cap', { cap: MAX_OPEN_FILE_WATCHES, taskId })
    // What's counted changes with what's watched: a file closed and opened again counts from its watch's start.
    const counters = new Map<string, number>()
    const previous = versions.get(taskId)
    for (const path of wanted) counters.set(path, previous?.get(path) ?? 0)
    versions.set(taskId, counters)
  }

  return {
    watch,

    observe(event) {
      if (event.type === EventType.OpenFilesChanged) {
        void watch(event.openFiles.taskId, event.openFiles.paths)
        return
      }
      if (event.type === EventType.TaskDeleted) stop(event.taskId)
    },

    close() {
      for (const taskId of [...watched.keys()]) stop(taskId)
      for (const { timer } of waiting.values()) clearTimeout(timer)
      waiting.clear()
    },
  }
}
