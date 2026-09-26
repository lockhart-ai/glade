/**
 * Keeps the Artifacts tab's order live (#307): the tab lists artifacts by when their files last changed, so when one
 * may have changed, it's looked at again (`refreshTaskArtifacts`), and moves. Two things say one may have:
 *
 * - a finished tool call in the task, or one of its subagents, that wrote to its path: Write, Edit, MultiEdit and
 *   NotebookEdit name the file; a Bash command does when the path is in it;
 * - while the tab shows the task (`artifacts.watch` until `artifacts.unwatch`), a change in the folder the file is in
 *   (`fs.watch`), so edits from outside the agent, in the terminal or an editor, count too. Watching the folder rather
 *   than the file follows an editor that saves by writing a new file over the old one.
 *
 * Changes close together are looked at once: the first starts a short wait, and every file changed during it is looked
 * at when it ends. Opening the tab looks at every file at once, for what changed while it was closed.
 */
import { watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { ToolCallState, ToolEventKind, type ToolCallEvent } from '../../shared/domain'
import { CHANGING_TOOLS, workspaceRelativePath } from '../../shared/files'
import { listArtifacts } from '../db/repositories/artifacts'
import { workspaceFilesRoot, workspaceRoot } from '../files/files'
import type { TaskServiceContext } from '../tasks/service'
import { refreshTaskArtifacts } from './artifacts'

/** How long a change waits for others before the files it names are looked at, in milliseconds. */
export const ARTIFACT_CHANGE_WAIT_MS = 250

/** A folder being watched. */
export interface FolderWatch {
  close(): void
}

/**
 * Watches a folder for changes to what's in it, calling back with the name of the file that changed, or null when it
 * can't tell. Throws when the folder can't be watched (it's gone).
 */
export type WatchFolder = (folder: string, onChange: (fileName: string | null) => void) => FolderWatch

/** Node's `fs.watch` on the folder (FSEvents, on macOS), which never keeps the app running, and stops on an error. */
export const watchFolderWithFs: WatchFolder = (folder, onChange) => {
  const watcher = watch(folder, { persistent: false }, (_event, fileName) => {
    onChange(fileName)
  })
  const close = (): void => {
    watcher.close()
  }
  watcher.on('error', close)
  return { close }
}

export interface ArtifactWatcherOptions {
  readonly context: TaskServiceContext
  /** How folders are watched: `fs.watch` by default. */
  readonly watchFolder?: WatchFolder
  /** How long a change waits for others: `ARTIFACT_CHANGE_WAIT_MS` by default. */
  readonly waitMs?: number
}

export interface ArtifactWatcher {
  /**
   * The Artifacts tab shows the task (`artifacts.watch`): every artifact's file is looked at now, and the folders
   * they're in are watched until the tab lets it go. Counted: each `watch` is ended by an `unwatch`.
   */
  watch(taskId: string): void
  /** The tab no longer shows the task (`artifacts.unwatch`): once no tab does, its folders aren't watched. */
  unwatch(taskId: string): void
  /**
   * Hears every event on its way to the windows: a finished tool call that may have written an artifact's file, and a
   * watched task's artifacts changing, which may change the folders to watch.
   */
  observe(event: GladeEvent): void
  /** Stops watching everything, and drops the changes waiting to be looked at (the app is quitting). */
  close(): void
}

/** A watched task: how many tabs show it, and its folders being watched, by path. */
interface Watched {
  count: number
  folders: Map<string, FolderWatch>
}

/** The artifacts a finished tool call may have written: the file an editing tool names, or the paths in a command. */
function writtenBy(call: ToolCallEvent, root: string, paths: readonly string[]): string[] {
  const field = CHANGING_TOOLS[call.name]
  const named = field === undefined ? undefined : call.input[field]
  if (typeof named === 'string') {
    const path = workspaceRelativePath(named, root)
    return path !== null && paths.includes(path) ? [path] : []
  }
  const { command } = call.input
  if (call.name !== 'Bash' || typeof command !== 'string') return []
  return paths.filter((path) => command.includes(path) || command.includes(join(root, path)))
}

export function createArtifactWatcher({
  context,
  watchFolder = watchFolderWithFs,
  waitMs = ARTIFACT_CHANGE_WAIT_MS,
}: ArtifactWatcherOptions): ArtifactWatcher {
  const watched = new Map<string, Watched>()
  // The files changed while a change waits for others, by task, and the wait.
  const waiting = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>()

  const refresh = (taskId: string, paths?: readonly string[]): void => {
    // Looking fails only as the app quits, with the database closed: there's nothing to show it to.
    refreshTaskArtifacts(context, taskId, paths).catch(() => undefined)
  }

  /** Notes that files of a task's artifacts may have changed, to be looked at once the wait is over. */
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
      refresh(taskId, [...waitingPaths])
    }, waitMs)
    waiting.set(taskId, { paths: waitingPaths, timer })
  }

  const rootOf = (taskId: string): string | null => {
    try {
      return workspaceRoot(context, taskId)
    } catch {
      return null
    }
  }

  /** A task's artifacts, by the folder each file is in (absolute). None for a task that's gone. */
  const artifactsByFolder = (taskId: string): Map<string, string[]> => {
    const byFolder = new Map<string, string[]>()
    const root = rootOf(taskId)
    if (root === null) return byFolder
    for (const { path } of listArtifacts(context.db, taskId)) {
      const folder = dirname(join(workspaceFilesRoot(root), path))
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), path])
    }
    return byFolder
  }

  /** A change in a watched folder: the artifact it names in it, or all of them when it can't tell which file. */
  const folderChanged = (taskId: string, folder: string, fileName: string | null): void => {
    // The folder's artifacts as they are now, not as they were when it was first watched.
    const paths = artifactsByFolder(taskId).get(folder) ?? []
    changed(taskId, fileName === null ? paths : paths.filter((path) => basename(path) === fileName))
  }

  /** Watches the folders a watched task's artifacts are in, and no others. */
  const syncFolders = (taskId: string, task: Watched): void => {
    const byFolder = artifactsByFolder(taskId)
    for (const [folder, folderWatch] of task.folders) {
      if (byFolder.has(folder)) continue
      folderWatch.close()
      task.folders.delete(folder)
    }
    for (const folder of byFolder.keys()) {
      if (task.folders.has(folder)) continue
      try {
        task.folders.set(
          folder,
          watchFolder(folder, (fileName) => {
            folderChanged(taskId, folder, fileName)
          }),
        )
      } catch {
        // A folder that's gone can't be watched: its artifacts show as missing until the tab looks again.
      }
    }
  }

  const stopWatching = (task: Watched): void => {
    for (const folderWatch of task.folders.values()) folderWatch.close()
    task.folders.clear()
  }

  return {
    watch(taskId) {
      const task = watched.get(taskId)
      if (task !== undefined) {
        task.count++
        return
      }
      const started: Watched = { count: 1, folders: new Map() }
      watched.set(taskId, started)
      syncFolders(taskId, started)
      refresh(taskId)
    },

    unwatch(taskId) {
      const task = watched.get(taskId)
      if (task === undefined) return
      task.count--
      if (task.count > 0) return
      stopWatching(task)
      watched.delete(taskId)
    },

    observe(event) {
      if (event.type === EventType.ArtifactsChanged) {
        const task = watched.get(event.taskId)
        if (task !== undefined) syncFolders(event.taskId, task)
        return
      }
      if (event.type !== EventType.ToolEventUpdated) return
      const call = event.toolEvent
      if (call.kind !== ToolEventKind.ToolCall || call.state === ToolCallState.Running) return
      const root = rootOf(call.taskId)
      if (root === null) return
      const paths = listArtifacts(context.db, call.taskId).map(({ path }) => path)
      changed(call.taskId, writtenBy(call, root, paths))
    },

    close() {
      for (const task of watched.values()) stopWatching(task)
      watched.clear()
      for (const { timer } of waiting.values()) clearTimeout(timer)
      waiting.clear()
    },
  }
}
