/**
 * The todo hub (P16, #491): a todo is a step of work, and what the task made for that step (its **children**: files,
 * links, subagents, watchers and commits) sits under it. This is what both sides share of it: what a child and its
 * **filing** are, what a todo's panel remembers, and `groupChildren`, which works out each todo's children.
 *
 * It's all behind the hidden setting `todoHubEnabled` (`./settings`), off until the phase's last issue (#501): with it
 * off, nothing here is read, written, sent or shown.
 */
import {
  ArtifactKind,
  ToolCallState,
  ToolEventKind,
  WatcherState,
  type Artifact,
  type ArtifactRef,
  type EpochMs,
  type TaskCommit,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from './domain'
import { isSubagentTool } from './subagents'

/** What a child of a todo is. */
export enum ChildKind {
  /** A file artifact. */
  File = 'file',
  /** A link artifact. */
  Link = 'link',
  /** A subagent: an `Agent` call, a subagent's own included. */
  Subagent = 'subagent',
  /** A watcher, one a subagent left running included. */
  Watcher = 'watcher',
  /** A commit the task's agent or one of its subagents made. */
  Commit = 'commit',
}

/** Every kind, in the order a todo shows them: files, links, subagents, watchers, changes. */
export const CHILD_KINDS: readonly ChildKind[] = Object.values(ChildKind)

/**
 * Names one child of a task, by its kind and its own key within that kind:
 *
 * - a file by its artifact's path, relative to the workspace root (`FileArtifact.path`);
 * - a link by its artifact's URL (`LinkArtifact.url`);
 * - a subagent by the `tool_use` id of the `Agent` call that started it;
 * - a watcher by the `tool_use` id of the call that started it (`Watcher.toolUseId`);
 * - a commit by its hash and repository (`commitChildKey`).
 */
export interface ChildRef {
  readonly kind: ChildKind
  readonly key: string
}

/**
 * A child's short id within its task, which Glade shows the agent and the agent files and moves children by: `c1`,
 * `c2`, … Every child Glade has named to the agent has one, filed or not, numbered in the order they were first named.
 * It's kept in SQLite (`child_ids`), so it's the same for the life of the task, across a compaction, a resume and a
 * relaunch, and it's never given to another child: not when the first one is removed, nor when it comes back (an
 * artifact declared again has the id it had).
 */
export type ChildId = string

/** A child with its short id. */
export interface IdentifiedChild extends ChildRef {
  readonly id: ChildId
}

/** The short id with this number: `c3` for 3. */
export function childId(number: number): ChildId {
  return `c${String(number)}`
}

const CHILD_ID = /^c([1-9]\d*)$/

/** The number of a short id; null for text that isn't one (`c0`, `C3`, `3`). */
export function childIdNumber(id: string): number | null {
  const number = Number(CHILD_ID.exec(id)?.[1])
  return Number.isSafeInteger(number) ? number : null
}

/** How a child came to be under its todo. */
export enum FilingSource {
  /** The call that made it named the todo. */
  Named = 'named',
  /**
   * The call named none, and the agent filed it itself (`file_children`): when Glade asked, right after the call or as
   * its turn ended, or when you asked it to sort what the task made before the hub. Any filing by the agent of a child
   * that had none of its own.
   */
  Asked = 'asked',
  /**
   * It was made by a subagent, and went where the subagent is. Not a filing of its own: the child still follows its
   * subagent when that one moves (`groupChildren`).
   */
  Inherited = 'inherited',
  /**
   * The agent moved it here (`file_children`) from the todo it was filed under: any filing by the agent of a child
   * that had one of its own, one whose todo has since been deleted included.
   */
  Moved = 'moved',
}

/**
 * The id of a todo, as Claude Code gives it (`Task #N`, `Todo.id`): unique within a task, the same across a
 * compaction, a resume and a relaunch, and never used again once its todo is deleted (`docs/sdk-notes.md` §16).
 */
export type TodoId = string

/** A child filed under a todo: this child, this todo, how it was filed, and when. A child has one filing at most. */
export interface Filing extends ChildRef {
  readonly taskId: string
  readonly todoId: TodoId
  readonly source: FilingSource
  readonly filedAt: EpochMs
}

/** A filing to make: the child, the todo it goes under, and how it's filed. */
export interface NewFiling extends ChildRef {
  readonly todoId: TodoId
  readonly source: FilingSource
}

/**
 * The id that stands for "Not under a todo", the placeholder group for children with no todo: what its panel state
 * and its group are kept under. No todo has it (Claude Code's ids are counting numbers), no filing may name it, and a
 * todo that ever did would have no children of its own.
 */
export const UNFILED_TODO_ID: TodoId = 'unfiled'

/** What a hub command is refused with while the hub is off (`todoHubEnabled`). */
export const TODO_HUB_OFF = 'The todo hub is off (the todoHubEnabled setting).'

/** Which of a todo's children its open panel shows: all of them, or one kind alone. */
export enum ChildFilter {
  All = 'all',
  Files = 'file',
  Links = 'link',
  Subagents = 'subagent',
  Watchers = 'watcher',
  Commits = 'commit',
}

/** What a todo's panel remembers, as you left it: whether it's open, and its filter. One per todo of a task. */
export interface TodoPanel {
  readonly taskId: string
  /** The todo's id, or `UNFILED_TODO_ID` for the placeholder group. */
  readonly todoId: TodoId
  readonly open: boolean
  readonly filter: ChildFilter
}

/** A commit's key as a child: its full hash, a space, then the working tree it was made in. */
export function commitChildKey({ hash, repoPath }: Pick<TaskCommit, 'hash' | 'repoPath'>): string {
  return `${hash} ${repoPath}`
}

/** Which child an artifact is, by what names it: a file's path, relative to the workspace root, or a link's URL. */
export function childOfArtifact(artifact: ArtifactRef): ChildRef {
  switch (artifact.kind) {
    case ArtifactKind.File:
      return { kind: ChildKind.File, key: artifact.path }
    case ArtifactKind.Link:
      return { kind: ChildKind.Link, key: artifact.url }
  }
}

/** Which child a subagent is, by the `Agent` call that started it. */
export function childOfSubagent({ toolUseId }: Pick<ToolCallEvent, 'toolUseId'>): ChildRef {
  return { kind: ChildKind.Subagent, key: toolUseId }
}

/** Which child a watcher is. */
export function childOfWatcher({ toolUseId }: Pick<Watcher, 'toolUseId'>): ChildRef {
  return { kind: ChildKind.Watcher, key: toolUseId }
}

/** Which child a commit is. */
export function childOfCommit(commit: Pick<TaskCommit, 'hash' | 'repoPath'>): ChildRef {
  return { kind: ChildKind.Commit, key: commitChildKey(commit) }
}

/** A subagent, as `groupChildren` takes it. */
export interface SubagentChild {
  /** The `Agent` call that started it; its `parentToolUseId` is the subagent that made it, if one did. */
  readonly call: ToolCallEvent
  /** When it last did anything: its latest tool call, note or result, else when it started. */
  readonly lastActivityAt: EpochMs
}

/**
 * A task's subagents, from its tool log: every `Agent` call, nested ones included, in the order they started, each
 * with when it last did anything (the latest of its own calls, notes and results, else its call's result, else its
 * start). What the window groups from, as main does from the stored log (`taskChildren` in `src/main/todo-hub`). One
 * pass over the log.
 */
export function subagentsOf(events: readonly ToolEvent[]): SubagentChild[] {
  const calls: ToolCallEvent[] = []
  const activity = new Map<string, EpochMs>()
  for (const event of events) {
    if (event.kind !== ToolEventKind.ToolCall && event.kind !== ToolEventKind.Narration) continue
    if (event.kind === ToolEventKind.ToolCall && isSubagentTool(event.name)) calls.push(event)
    if (event.parentToolUseId === null) continue
    const finishedAt = event.kind === ToolEventKind.ToolCall ? (event.finishedAt ?? 0) : 0
    const at = Math.max(event.createdAt, finishedAt, activity.get(event.parentToolUseId) ?? 0)
    activity.set(event.parentToolUseId, at)
  }
  return calls.map((call) => ({
    call,
    lastActivityAt: Math.max(call.createdAt, call.finishedAt ?? 0, activity.get(call.toolUseId) ?? 0),
  }))
}

/**
 * Every child among a task's artifacts, subagents, watchers and commits, each kind in the order it came, but for the
 * commits, which a task lists newest first and this puts oldest first: of those committed in the same second, the one
 * Glade found first. So each kind is oldest first as main reads them: the order they get their short ids in when
 * Glade first names them all at once (a task from before the hub).
 */
export function childrenOf({
  artifacts,
  subagents,
  watchers,
  commits,
}: Pick<TaskChildren, 'artifacts' | 'subagents' | 'watchers' | 'commits'>): ChildRef[] {
  return [
    ...artifacts.map(childOfArtifact),
    ...subagents.map(({ call }) => childOfSubagent(call)),
    ...watchers.map(childOfWatcher),
    // Reversed first: the sort keeps the order of those committed in the same second, which is newest first as given.
    ...[...commits]
      .reverse()
      .sort((a, b) => a.committedAt - b.committedAt)
      .map(childOfCommit),
  ]
}

/** Everything of a task `groupChildren` works from. */
export interface TaskChildren {
  /** The task's todo list, in the agent's order. */
  readonly todos: readonly Todo[]
  readonly artifacts: readonly Artifact[]
  /** Every subagent of the task, nested ones included. */
  readonly subagents: readonly SubagentChild[]
  /** Every watcher of the task, the ones its subagents started included. */
  readonly watchers: readonly Watcher[]
  readonly commits: readonly TaskCommit[]
  readonly filings: readonly Filing[]
}

/** A child where `groupChildren` put it. */
export interface Child extends ChildRef {
  /**
   * When it last changed, which orders a todo's list: a file's last change (when it was declared, until Glade has
   * looked at the file), a link's last change, a subagent's latest activity, a watcher's last wake (else its end, else
   * its start), a commit's time.
   */
  readonly updatedAt: EpochMs
  /** Whether it's running now: a running subagent, or a watcher whose process runs. Never a file, link or commit. */
  readonly live: boolean
  /**
   * How it came under its todo: by its own filing, or `Inherited` from the subagent that made it. Null in the
   * placeholder group.
   */
  readonly source: FilingSource | null
}

/** One kind of a todo's children, in brief: how many, and whether any is live. */
export interface KindTally {
  readonly count: number
  readonly live: boolean
}

/** A todo's children, counted by kind. */
export type ChildTallies = Readonly<Record<ChildKind, KindTally>>

/** A todo's children. */
export interface TodoChildren {
  /** The todo's id, or `UNFILED_TODO_ID` for the placeholder group. */
  readonly todoId: TodoId
  /** Every child, whatever its kind, most recently updated first. */
  readonly children: readonly Child[]
  readonly tallies: ChildTallies
}

/** A task's children, grouped by todo. */
export interface GroupedChildren {
  /** One per todo that has an id, in the agent's order, the ones with no children included. */
  readonly todos: readonly TodoChildren[]
  /** "Not under a todo": the children no todo has. */
  readonly unfiled: TodoChildren
}

/** Where a child goes: a todo's id and how it got there, or the placeholder group. */
interface Place {
  readonly todoId: TodoId
  readonly source: FilingSource | null
}

const UNFILED: Place = { todoId: UNFILED_TODO_ID, source: null }

/** A child as a map keys it. A kind has no colon, so no two children share one. */
export function refKey({ kind, key }: ChildRef): string {
  return `${kind}:${key}`
}

function tallies(children: readonly Child[]): ChildTallies {
  const tally = (kind: ChildKind): KindTally => {
    const ofKind = children.filter((child) => child.kind === kind)
    return { count: ofKind.length, live: ofKind.some(({ live }) => live) }
  }
  return {
    [ChildKind.File]: tally(ChildKind.File),
    [ChildKind.Link]: tally(ChildKind.Link),
    [ChildKind.Subagent]: tally(ChildKind.Subagent),
    [ChildKind.Watcher]: tally(ChildKind.Watcher),
    [ChildKind.Commit]: tally(ChildKind.Commit),
  }
}

/** A group's children as it lists them: most recently updated first, and otherwise in the order they came. */
function grouped(todoId: TodoId, children: Child[]): TodoChildren {
  children.sort((a, b) => b.updatedAt - a.updatedAt)
  return { todoId, children, tallies: tallies(children) }
}

/**
 * Each todo's children, from everything a task has (pure, and one pass over each list, so it's cheap to run again on
 * every change).
 *
 * - A child goes under the todo its filing names. One with no filing, or whose todo isn't in the list any more
 *   (deleted), goes to the placeholder group.
 * - A child a subagent made (a watcher, a commit, a subagent of its own) follows that subagent, however deep, unless
 *   it has a filing of its own: any but an `Inherited` one. So moving a subagent brings what it made, apart from what
 *   was filed on its own. An `Inherited` filing only decides for a child whose subagent isn't known (an artifact,
 *   say).
 * - Each group counts its children by kind, flags a kind with a live one, and lists them most recently updated first.
 * - A todo with no id (`TodoWrite`'s) has no group: nothing can be filed under it.
 *
 * It never throws on input the store can't produce: of two filings for one child the later counts, of two todos
 * sharing an id the first has the children, and a subagent that is its own ancestor falls to the placeholder.
 */
export function groupChildren({
  todos,
  artifacts,
  subagents,
  watchers,
  commits,
  filings,
}: TaskChildren): GroupedChildren {
  const groups = new Map<TodoId, Child[]>()
  for (const { id } of todos) {
    if (id !== null && id !== UNFILED_TODO_ID && !groups.has(id)) groups.set(id, [])
  }
  const unfiled: Child[] = []

  const filed = new Map<string, Filing>()
  for (const filing of filings) {
    const key = refKey(filing)
    const earlier = filed.get(key)
    if (earlier === undefined || filing.filedAt >= earlier.filedAt) filed.set(key, filing)
  }

  /** Under the todo a filing names, or the placeholder once that todo is gone. */
  const under = ({ todoId, source }: Filing): Place => (groups.has(todoId) ? { todoId, source } : UNFILED)

  const callOf = new Map<string, ToolCallEvent>()
  for (const { call } of subagents) callOf.set(call.toolUseId, call)
  const subagentPlaces = new Map<string, Place>()

  /** Where a child goes, given the subagent that made it (the `tool_use` id of its `Agent` call), if one did. */
  const placeOf = (ref: ChildRef, madeBy: string | null): Place => {
    const filing = filed.get(refKey(ref))
    if (filing !== undefined && filing.source !== FilingSource.Inherited) return under(filing)
    const maker = madeBy === null ? undefined : callOf.get(madeBy)
    if (maker !== undefined) {
      const { todoId } = placeOfSubagent(maker)
      return todoId === UNFILED_TODO_ID ? UNFILED : { todoId, source: FilingSource.Inherited }
    }
    return filing === undefined ? UNFILED : under(filing)
  }

  const placeOfSubagent = (call: ToolCallEvent): Place => {
    const known = subagentPlaces.get(call.toolUseId)
    if (known !== undefined) return known
    // Until it's worked out: a subagent reached again from its own makers has no todo to follow.
    subagentPlaces.set(call.toolUseId, UNFILED)
    const place = placeOf(childOfSubagent(call), call.parentToolUseId)
    subagentPlaces.set(call.toolUseId, place)
    return place
  }

  const put = (ref: ChildRef, { todoId, source }: Place, updatedAt: EpochMs, live: boolean): void => {
    const group = groups.get(todoId) ?? unfiled
    group.push({ kind: ref.kind, key: ref.key, updatedAt, live, source })
  }

  for (const artifact of artifacts) {
    const ref = childOfArtifact(artifact)
    const changedAt =
      artifact.kind === ArtifactKind.File ? (artifact.modifiedAt ?? artifact.updatedAt) : artifact.updatedAt
    put(ref, placeOf(ref, null), changedAt, false)
  }
  for (const { call, lastActivityAt } of subagents) {
    put(childOfSubagent(call), placeOfSubagent(call), lastActivityAt, call.state === ToolCallState.Running)
  }
  for (const watcher of watchers) {
    const ref = childOfWatcher(watcher)
    const changedAt = watcher.lastWokeAt ?? watcher.endedAt ?? watcher.startedAt
    put(ref, placeOf(ref, watcher.parentToolUseId), changedAt, watcher.state === WatcherState.Running)
  }
  for (const commit of commits) {
    const ref = childOfCommit(commit)
    put(ref, placeOf(ref, commit.subagentToolUseId), commit.committedAt, false)
  }

  return {
    todos: [...groups].map(([todoId, children]) => grouped(todoId, children)),
    unfiled: grouped(UNFILED_TODO_ID, unfiled),
  }
}
