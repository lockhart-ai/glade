/**
 * Finds one child of a task among the store's lists, by its key (`ChildRef.key`), for its tile in the todo hub.
 *
 * A tile reads its own child from the store, so a change to one child renders that tile alone. Every mounted tile's
 * selector runs on every change to the store, so a lookup can't walk a list (a task has hundreds of commits, and a
 * todo fifty tiles): each list is indexed once, the first time a tile asks, and the index is kept for as long as the
 * list is the store's (a changed list is a new array, and the old index goes with the old one).
 */
import type { Artifact, TaskCommit, ToolCallEvent, ToolEvent } from '../../../shared/domain'
import { childOfArtifact, refKey, commitChildKey, subagentsOf } from '../../../shared/todoHub'

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

const subagentLists = new WeakMap<readonly ToolEvent[], readonly ToolCallEvent[]>()

/**
 * A tool log's subagents (`subagentsOf`), worked out once per log: the hub groups from them, since a subagent's commits
 * go under the todo it works on, and a commit's tile finds the one that made it among them.
 */
export function subagentsIn(events: readonly ToolEvent[]): readonly ToolCallEvent[] {
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

/**
 * The subagent a task's tool log has for an `Agent` call's `tool_use` id: its call. For the name of the subagent that
 * made a commit, on the commit's tile; a subagent has no tile of its own.
 */
export const findSubagent = indexedBy((events: readonly ToolEvent[]) =>
  byKey(subagentsIn(events), ({ toolUseId }) => toolUseId),
)

/** The commit with a child's key (`commitChildKey`) among a task's commits. */
export const findCommit = indexedBy((commits: readonly TaskCommit[]) => byKey(commits, commitChildKey))
