/**
 * Finds one child of a task among the store's lists, by its key (`ChildRef.key`), for its tile in the todo hub.
 *
 * A tile reads its own child from the store, so a change to one child renders that tile alone. Every mounted tile's
 * selector runs on every change to the store, so a lookup can't walk a list (a tool log has thousands of entries, and
 * a todo fifty tiles): each list is indexed once, the first time a tile asks, and the index is kept for as long as the
 * list is the store's (a changed list is a new array, and the old index goes with the old one).
 */
import type { Artifact, TaskCommit, ToolEvent, Watcher } from '../../../shared/domain'
import { childOfArtifact, refKey, commitChildKey, subagentsOf, type SubagentChild } from '../../../shared/todoHub'

type Index<T> = ReadonlyMap<string, T>

/** A lookup into a list by key, indexed once per list. */
function indexedBy<S extends object, T>(
  index: (list: S) => Index<T>,
): (list: S | undefined, key: string) => T | undefined {
  const indexes = new WeakMap<S, Index<T>>()
  return (list, key) => {
    if (list === undefined) return undefined
    let known = indexes.get(list)
    if (known === undefined) {
      known = index(list)
      indexes.set(list, known)
    }
    return known.get(key)
  }
}

/** A list's items by their key; of two with the same key (which the store never has), the first. */
function byKey<T>(items: readonly T[], keyOf: (item: T) => string): Index<T> {
  const index = new Map<string, T>()
  for (const item of items) {
    const key = keyOf(item)
    if (!index.has(key)) index.set(key, item)
  }
  return index
}

const subagentLists = new WeakMap<readonly ToolEvent[], readonly SubagentChild[]>()

/**
 * A tool log's subagents (`subagentsOf`), worked out once per log: the hub groups from them, and each subagent's tile
 * finds its own among them.
 */
export function subagentsIn(events: readonly ToolEvent[]): readonly SubagentChild[] {
  let known = subagentLists.get(events)
  if (known === undefined) {
    known = subagentsOf(events)
    subagentLists.set(events, known)
  }
  return known
}

/** The file or link artifact that is a child, by the child as one string (`refKey`), among a task's artifacts. */
export const findArtifact = indexedBy((artifacts: readonly Artifact[]) =>
  byKey(artifacts, (artifact) => refKey(childOfArtifact(artifact))),
)

/** The subagent a task's tool log has for an `Agent` call's `tool_use` id, with when it last did anything. */
export const findSubagent = indexedBy((events: readonly ToolEvent[]) =>
  byKey(subagentsIn(events), ({ call }) => call.toolUseId),
)

/** The watcher the call with a `tool_use` id started, among a task's watchers. */
export const findWatcher = indexedBy((watchers: readonly Watcher[]) => byKey(watchers, ({ toolUseId }) => toolUseId))

/** The commit with a child's key (`commitChildKey`) among a task's commits. */
export const findCommit = indexedBy((commits: readonly TaskCommit[]) => byKey(commits, commitChildKey))
