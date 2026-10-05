/**
 * The todo hub (P16, #491): a todo is a step of work, and what the task produced for that step (its **children**:
 * files, links and commits) sits under it. This is what both sides share of it: what a child and its **filing** are,
 * what a todo's panel remembers, and `groupChildren`, which works out each todo's children.
 *
 * A todo shows produced work only (#535). A subagent has a todo too, the one it was started for, but as plumbing: it's
 * what the subagent's commits follow and what its tab in the Agents tab says (`subagentTodo`), and the subagent itself
 * is never shown under the todo. A watcher has none: it isn't filed, grouped or given an id.
 */
import {
  ArtifactKind,
  ToolEventKind,
  type Artifact,
  type ArtifactRef,
  type EpochMs,
  type TaskCommit,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
} from './domain'
import { isSubagentTool } from './subagents'

/** What Glade keeps a todo for: the three kinds of produced work, and a subagent. */
export enum ChildKind {
  /** A file artifact. */
  File = 'file',
  /** A link artifact. */
  Link = 'link',
  /**
   * A subagent: an `Agent` call, a subagent's own included. Its todo is the one it works on, kept as plumbing
   * (`subagentTodo`): a subagent isn't something its todo produced, and no todo shows one.
   */
  Subagent = 'subagent',
  /** A commit the task's agent or one of its subagents made. */
  Commit = 'commit',
}

/** Every kind Glade keeps a todo for. */
export const CHILD_KINDS: readonly ChildKind[] = Object.values(ChildKind)

/** What a todo shows under it, the work it produced: every kind but a subagent. */
export type ProducedKind = Exclude<ChildKind, ChildKind.Subagent>

/** The kinds a todo shows, in the order its row counts them: files, links, changes. */
export const PRODUCED_KINDS: readonly ProducedKind[] = [ChildKind.File, ChildKind.Link, ChildKind.Commit]

/**
 * Names one child of a task, by its kind and its own key within that kind:
 *
 * - a file by its artifact's path, relative to the workspace root (`FileArtifact.path`);
 * - a link by its artifact's URL (`LinkArtifact.url`);
 * - a subagent by the `tool_use` id of the `Agent` call that started it;
 * - a commit by its hash and repository (`commitChildKey`).
 */
export interface ChildRef {
  readonly kind: ChildKind
  readonly key: string
}

/** A child a todo shows: a file, a link or a commit. */
export interface ProducedRef extends ChildRef {
  readonly kind: ProducedKind
}

/**
 * A child's short id within its task, which Glade shows the agent and the agent files and moves children by: `c1`,
 * `c2`, … Every child Glade has named to the agent has one, filed or not, numbered in the order they were first named.
 * It's kept in SQLite (`child_ids`), so it's the same for the life of the task, across a compaction, a resume and a
 * relaunch, and it's never given to another child: not when the first one is removed, nor when it comes back (an
 * artifact declared again has the id it had), nor when it was a watcher's, from when watchers had ids (before #535).
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

/** Which of a todo's children its open panel shows: all of them, or one kind alone. */
export enum ChildFilter {
  All = 'all',
  Files = 'file',
  Links = 'link',
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
export function childOfArtifact(artifact: ArtifactRef): ProducedRef {
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

/** Which child a commit is. */
export function childOfCommit(commit: Pick<TaskCommit, 'hash' | 'repoPath'>): ProducedRef {
  return { kind: ChildKind.Commit, key: commitChildKey(commit) }
}

/**
 * A task's subagents, from its tool log: every `Agent` call, nested ones included, in the order they started. What the
 * window resolves from, as main does from the stored log (`taskChildren` in `src/main/todo-hub`). One pass over the
 * log.
 */
export function subagentsOf(events: readonly ToolEvent[]): ToolCallEvent[] {
  return events.filter(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && isSubagentTool(event.name),
  )
}

/**
 * Every child among a task's artifacts, subagents and commits, each kind in the order it came, but for the commits,
 * which a task lists newest first and this puts oldest first: of those committed in the same second, the one Glade
 * found first. So each kind is oldest first as main reads them: the order they get their short ids in when Glade first
 * names several at once (a task from before the hub).
 */
export function childrenOf({
  artifacts,
  subagents,
  commits,
}: Pick<TaskChildren, 'artifacts' | 'subagents' | 'commits'>): ChildRef[] {
  return [
    ...artifacts.map(childOfArtifact),
    ...subagents.map(childOfSubagent),
    // Reversed first: the sort keeps the order of those committed in the same second, which is newest first as given.
    ...[...commits]
      .reverse()
      .sort((a, b) => a.committedAt - b.committedAt)
      .map(childOfCommit),
  ]
}

/** What says which todo a subagent works on: the task's todos, its subagents, and its filings. */
export interface TodoPlumbing {
  /** The task's todo list, in the agent's order. */
  readonly todos: readonly Todo[]
  /**
   * Every subagent of the task, by the `Agent` call that started it, nested ones included; a call's `parentToolUseId`
   * is the subagent that made it, if one did.
   */
  readonly subagents: readonly ToolCallEvent[]
  readonly filings: readonly Filing[]
}

/** Everything of a task `groupChildren` works from: what it produced, and what says where each thing goes. */
export interface TaskChildren extends TodoPlumbing {
  readonly artifacts: readonly Artifact[]
  readonly commits: readonly TaskCommit[]
}

/** A child where `groupChildren` put it: a file, a link or a commit. */
export interface Child extends ProducedRef {
  /**
   * When it last changed, which orders a todo's list: a file's last change (when it was declared, until Glade has
   * looked at the file), a link's last change, a commit's time.
   */
  readonly updatedAt: EpochMs
  /**
   * How it came under its todo: by its own filing, or `Inherited` from the subagent that made it. Null in the
   * placeholder group.
   */
  readonly source: FilingSource | null
}

/** How many of each kind a todo has under it. */
export type ChildTallies = Readonly<Record<ProducedKind, number>>

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
  const counts = { [ChildKind.File]: 0, [ChildKind.Link]: 0, [ChildKind.Commit]: 0 }
  for (const { kind } of children) counts[kind] += 1
  return counts
}

/** A group's children as it lists them: most recently updated first, and otherwise in the order they came. */
function grouped(todoId: TodoId, children: Child[]): TodoChildren {
  children.sort((a, b) => b.updatedAt - a.updatedAt)
  return { todoId, children, tallies: tallies(children) }
}

/** Where each thing of a task goes, as its todos, its subagents and its filings say. */
interface Places {
  /** The id of every todo that has one, in the agent's order: of two sharing an id, once. */
  readonly todoIds: ReadonlySet<TodoId>
  /** Where a child goes, given the subagent that made it (the `tool_use` id of its `Agent` call), if one did. */
  readonly of: (ref: ChildRef, madeBy: string | null) => Place
  /** The todo a subagent works on, or the placeholder while it has none. */
  readonly ofSubagent: (call: ToolCallEvent) => Place
}

/**
 * Works out where things go (one pass over each list):
 *
 * - A child goes under the todo its filing names. One with no filing, or whose todo isn't in the list any more
 *   (deleted), goes to the placeholder group.
 * - A child a subagent made (a commit, a subagent of its own) follows that subagent's todo, however deep, unless it has
 *   a filing of its own: any but an `Inherited` one. So giving a subagent another todo brings what it made, apart from
 *   what was filed on its own. An `Inherited` filing only decides for a child whose subagent isn't known (an artifact,
 *   say).
 * - A todo with no id (`TodoWrite`'s) holds nothing: nothing can be filed under it.
 *
 * It never throws on input the store can't produce: of two filings for one child the later counts, and a subagent that
 * is its own ancestor has no todo.
 */
function placesIn({ todos, subagents, filings }: TodoPlumbing): Places {
  const todoIds = new Set<TodoId>()
  for (const { id } of todos) {
    if (id !== null && id !== UNFILED_TODO_ID) todoIds.add(id)
  }

  const filed = new Map<string, Filing>()
  for (const filing of filings) {
    const key = refKey(filing)
    const earlier = filed.get(key)
    if (earlier === undefined || filing.filedAt >= earlier.filedAt) filed.set(key, filing)
  }

  /** Under the todo a filing names, or the placeholder once that todo is gone. */
  const under = ({ todoId, source }: Filing): Place => (todoIds.has(todoId) ? { todoId, source } : UNFILED)

  const callOf = new Map<string, ToolCallEvent>()
  for (const call of subagents) callOf.set(call.toolUseId, call)
  const subagentPlaces = new Map<string, Place>()

  const of = (ref: ChildRef, madeBy: string | null): Place => {
    const filing = filed.get(refKey(ref))
    if (filing !== undefined && filing.source !== FilingSource.Inherited) return under(filing)
    const maker = madeBy === null ? undefined : callOf.get(madeBy)
    if (maker !== undefined) {
      const { todoId } = ofSubagent(maker)
      return todoId === UNFILED_TODO_ID ? UNFILED : { todoId, source: FilingSource.Inherited }
    }
    return filing === undefined ? UNFILED : under(filing)
  }

  const ofSubagent = (call: ToolCallEvent): Place => {
    const known = subagentPlaces.get(call.toolUseId)
    if (known !== undefined) return known
    // Until it's worked out: a subagent reached again from its own makers has no todo to follow.
    subagentPlaces.set(call.toolUseId, UNFILED)
    const place = of(childOfSubagent(call), call.parentToolUseId)
    subagentPlaces.set(call.toolUseId, place)
    return place
  }

  return { todoIds, of, ofSubagent }
}

/**
 * What each todo produced, from everything a task has (pure, and one pass over each list, so it's cheap to run again
 * on every change): its files, links and commits, each under the todo `placesIn` puts it.
 *
 * - A subagent is never one of a todo's children, and a watcher isn't known here at all. A subagent's todo still
 *   decides where its commits go.
 * - Each group counts its children by kind, and lists them most recently updated first.
 * - A todo with no id (`TodoWrite`'s) has no group, and of two todos sharing an id the first has the children.
 */
export function groupChildren(children: TaskChildren): GroupedChildren {
  const places = placesIn(children)
  const groups = new Map<TodoId, Child[]>()
  for (const id of places.todoIds) groups.set(id, [])
  const unfiled: Child[] = []

  const put = ({ kind, key }: ProducedRef, madeBy: string | null, updatedAt: EpochMs): void => {
    const { todoId, source } = places.of({ kind, key }, madeBy)
    const group = groups.get(todoId) ?? unfiled
    group.push({ kind, key, updatedAt, source })
  }

  for (const artifact of children.artifacts) {
    const changedAt =
      artifact.kind === ArtifactKind.File ? (artifact.modifiedAt ?? artifact.updatedAt) : artifact.updatedAt
    put(childOfArtifact(artifact), null, changedAt)
  }
  for (const commit of children.commits) put(childOfCommit(commit), commit.subagentToolUseId, commit.committedAt)

  return {
    todos: [...groups].map(([todoId, list]) => grouped(todoId, list)),
    unfiled: grouped(UNFILED_TODO_ID, unfiled),
  }
}

/**
 * The todo each of a task's subagents works on, by the `tool_use` id of the `Agent` call that started it; a subagent
 * with none isn't in it (`subagentTodo`). One pass over each list.
 */
export function subagentTodos(plumbing: TodoPlumbing): Map<string, TodoId> {
  const places = placesIn(plumbing)
  const todos = new Map<string, TodoId>()
  for (const call of plumbing.subagents) {
    const { todoId } = places.ofSubagent(call)
    if (todoId !== UNFILED_TODO_ID) todos.set(call.toolUseId, todoId)
  }
  return todos
}

/**
 * The todo a subagent works on (P16-04, #495), by the `Agent` call that started it: the one that call named, or the
 * agent filed it under since, else the one the subagent that started it works on, however deep. Null while it has
 * none, once its todo is no longer in the list, and for a call that isn't one of the task's subagents. One subagent
 * works on one todo; it's what its commits follow, and what its tab says (#536). It's plumbing, read from the
 * subagent's filing: a subagent isn't something its todo produced, and `groupChildren` never lists one.
 */
export function subagentTodo(plumbing: TodoPlumbing, toolUseId: string): TodoId | null {
  const call = plumbing.subagents.find((subagent) => subagent.toolUseId === toolUseId)
  if (call === undefined) return null
  const { todoId } = placesIn(plumbing).ofSubagent(call)
  return todoId === UNFILED_TODO_ID ? null : todoId
}
