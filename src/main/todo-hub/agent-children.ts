/**
 * A task's children as its agent sees and sorts them (P16-05, #496; `docs/model-surface.md`): what the Glade tools
 * `list_children` and `file_children` do (`../agent/glade-tools`), and the words Glade names a child and a todo to the
 * agent with.
 *
 * - **Listing** names every child the task has to the agent, so each has its short id from then on (`c1`, `c2`, …;
 *   `identifyChildren`), under the todo the resolver puts it (`groupChildren`), with a title a person would know it
 *   by.
 * - **Filing** takes several filings in one call, each a child's short id and a todo's id, and makes all of them or
 *   none: a child or a todo that isn't there refuses the whole call, saying which. It's how a child moves from one
 *   todo to another, and from the placeholder ("Not under a todo") to a todo; a subagent brings what it made, which
 *   the resolver does by itself, so no row of those is rewritten.
 *
 * Built dark, as the rest of the hub: both refuse while `todoHubEnabled` is off, and write and send nothing.
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import { TodoState, type EpochMs, type Todo } from '../../shared/domain'
import { subagentName } from '../../shared/subagents'
import {
  childIdNumber,
  childOfArtifact,
  childOfCommit,
  childOfSubagent,
  childOfWatcher,
  childrenOf,
  FilingSource,
  groupChildren,
  refKey,
  UNFILED_TODO_ID,
  type ChildId,
  type ChildRef,
  type Filing,
  type GroupedChildren,
  type IdentifiedChild,
  type NewFiling,
  type TaskChildren,
  type TodoId,
} from '../../shared/todoHub'
import { CommandFailure } from '../bridge/errors'
import { listFilings } from '../db/repositories/child-filings'
import { truncate } from '../notifications/notifications'
import {
  childWithId,
  fileChildren,
  identifyChildren,
  requireTodoHub,
  taskChildren,
  type FilingContext,
} from './todo-hub'

/** A todo children can be filed under: one with an id (`TaskCreate`'s; a `TodoWrite` item has none). */
export interface FilingTodo extends Todo {
  readonly id: TodoId
}

/** A child as the agent is told of it. */
export interface NamedChild extends IdentifiedChild {
  /**
   * What a person would know it by: an artifact's title, a subagent's name, a watcher's label, a commit's short hash
   * and subject. On one line, and cut to `CHILD_TITLE_MAX`.
   */
  readonly title: string
  /**
   * The short id of the subagent that made it, while it goes wherever that subagent goes: it has no filing of its own.
   * Null for a child the task's own agent made, and for one filed on its own.
   */
  readonly follows: ChildId | null
}

/** One todo's children, or the ones under no todo, as `list_children` answers. */
export interface ListedGroup {
  /** The todo; null for "Not under a todo". */
  readonly todo: FilingTodo | null
  /** By short id, lowest first. */
  readonly children: readonly NamedChild[]
}

/** One filing the agent asks for: a child, by its short id, and the todo to put it under, by its id. */
export interface FilingRequest {
  readonly child: string
  readonly todo: string
}

/** A child `file_children` filed, and the todo it's under now. */
export interface FiledChild {
  readonly id: ChildId
  readonly todoId: TodoId
}

/** What a `file_children` call did. */
export interface FilingOutcome {
  /** The children it filed, in the order asked. */
  readonly filed: readonly FiledChild[]
  /** The children already filed under the todo asked, which stay as they were. */
  readonly unchanged: readonly ChildId[]
  /** The children that changed todo without being named: what a subagent that moved had made. */
  readonly brought: readonly ChildId[]
}

/** What `list_children`'s `todo` takes for the children under no todo. */
export const NO_TODO = 'none'

/** The longest title, or todo, the agent is shown, in characters: longer ones are cut, with an ellipsis. */
export const CHILD_TITLE_MAX = 80

/** How many characters of a commit's hash the agent is shown. */
const SHORT_HASH = 7

/** What the agent is told when the task has no todo to file under, as #492 probed it (`docs/sdk-notes.md` §16). */
export const NO_TODOS = 'You have no todos yet: create one with TaskCreate first.'

/** What a refused `file_children` call starts with. */
export const NOTHING_FILED = 'Nothing was filed.'

/** What follows a `file_children` call refused over a child. */
export const LIST_FOR_IDS = "List the task's children for their ids."

/** A text on one line, cut to what the agent is shown. */
function shown(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), CHILD_TITLE_MAX)
}

/** The todos of a list that children can be filed under, in its order: of two sharing an id, the first. */
export function filingTodos(todos: readonly Todo[]): FilingTodo[] {
  const byId = new Map<TodoId, FilingTodo>()
  for (const todo of todos) {
    const { id } = todo
    if (id !== null && id !== UNFILED_TODO_ID && !byId.has(id)) byId.set(id, { ...todo, id })
  }
  return [...byId.values()]
}

/** A todo's state in Claude Code's own words, which the agent set it with. */
export function todoStatus(state: TodoState): string {
  switch (state) {
    case TodoState.Todo:
      return 'pending'
    case TodoState.Doing:
      return 'in progress'
    case TodoState.Done:
      return 'completed'
    case TodoState.Waiting:
      return 'waiting'
  }
}

/** A todo as the agent is told of it: `#2 Fix the UTC date test (in progress)`. */
export function todoLabel({ id, text, state }: FilingTodo): string {
  return `#${id} ${shown(text)} (${todoStatus(state)})`
}

/** A task's todos on one line, or that it has none yet: what a message about filing ends with. */
export function todosLine(todos: readonly FilingTodo[]): string {
  return todos.length === 0 ? NO_TODOS : `Your todos: ${todos.map(todoLabel).join(' · ')}`
}

/** A child as the agent is told of it: `c3: subagent "Review the date helpers"`. */
export function childLabel({ id, kind, title }: NamedChild): string {
  return `${id}: ${kind} "${title}"`
}

/** A todo's id as the agent gives it: `2`, or `#2` as Glade writes it. */
function todoIdOf(given: string): TodoId {
  return given.trim().replace(/^#/, '')
}

/** A child's short id as the agent gives it. */
function childIdOf(given: string): ChildId {
  return given.trim().toLowerCase()
}

/** Short ids, lowest number first. */
function byNumber(a: ChildId, b: ChildId): number {
  return (childIdNumber(a) ?? 0) - (childIdNumber(b) ?? 0)
}

/** The filings that are a child's own, by child: every one but an inherited one (`FilingSource.Inherited`). */
function ownFilings(filings: readonly Filing[]): Map<string, Filing> {
  return new Map(
    filings.filter(({ source }) => source !== FilingSource.Inherited).map((filing) => [refKey(filing), filing]),
  )
}

/** Which group each child is in: its todo's id, or `UNFILED_TODO_ID`. */
function placesOf({ todos, unfiled }: GroupedChildren): Map<string, TodoId> {
  const places = new Map<string, TodoId>()
  for (const { todoId, children } of [...todos, unfiled]) {
    for (const child of children) places.set(refKey(child), todoId)
  }
  return places
}

/** What each child of a task is called, and the subagent that made it (its `Agent` call), if one did. */
interface Described {
  readonly title: string
  readonly madeBy: string | null
}

function describeChildren({ artifacts, subagents, watchers, commits }: TaskChildren): Map<string, Described> {
  const described = new Map<string, Described>()
  for (const artifact of artifacts) {
    described.set(refKey(childOfArtifact(artifact)), { title: artifact.title, madeBy: null })
  }
  for (const { call } of subagents) {
    described.set(refKey(childOfSubagent(call)), { title: subagentName(call), madeBy: call.parentToolUseId })
  }
  for (const watcher of watchers) {
    const title = watcher.label.trim() === '' ? watcher.detail : watcher.label
    described.set(refKey(childOfWatcher(watcher)), { title, madeBy: watcher.parentToolUseId })
  }
  for (const commit of commits) {
    const title = `${commit.hash.slice(0, SHORT_HASH)} ${commit.subject}`
    described.set(refKey(childOfCommit(commit)), { title, madeBy: commit.subagentToolUseId })
  }
  return described
}

/**
 * Every child of a task as the agent is told of it, by short id, lowest first. A child Glade hasn't named before gets
 * its id here (`identifyChildren`).
 */
function nameChildren(db: Database, taskId: string, children: TaskChildren): NamedChild[] {
  const described = describeChildren(children)
  const identified = identifyChildren(db, taskId, childrenOf(children))
  const ids = new Map(identified.map((child) => [refKey(child), child.id]))
  const own = ownFilings(children.filings)
  return identified
    .map((child) => {
      const key = refKey(child)
      const found = described.get(key)
      const madeBy = found?.madeBy ?? null
      const maker =
        madeBy === null || own.has(key) ? undefined : ids.get(refKey(childOfSubagent({ toolUseId: madeBy })))
      return { ...child, title: shown(found?.title ?? ''), follows: maker ?? null }
    })
    .sort((a, b) => byNumber(a.id, b.id))
}

/** What refuses a call that names a todo the task's list doesn't have. */
function noSuchTodo(ids: readonly TodoId[], todos: readonly FilingTodo[]): string {
  return `There's no todo ${ids.map((id) => `#${id}`).join(', ')} in this task's list. ${todosLine(todos)}`
}

/**
 * A task's children as `list_children` answers: a group per todo, in the agent's order, then the ones under no todo.
 * Given `under`, that todo's group alone (by its id), or the ones under no todo alone (`NO_TODO`). Every child listed
 * has its short id from here on.
 *
 * Fails with `invalid_transition` while the hub is off, and `not_found` for a todo the task's list doesn't have, saying
 * which it does have.
 */
export function listForAgent(db: Database, taskId: string, under?: string): ListedGroup[] {
  requireTodoHub(db)
  const children = taskChildren(db, taskId)
  const todos = filingTodos(children.todos)
  const only = under === undefined ? undefined : todoIdOf(under)
  const wanted = only === undefined || only === NO_TODO ? todos : todos.filter(({ id }) => id === only)
  if (only !== undefined && only !== NO_TODO && wanted.length === 0) {
    throw new CommandFailure(BridgeErrorCode.NotFound, noSuchTodo([only], todos))
  }
  const places = placesOf(groupChildren(children))
  const groups = new Map<TodoId, NamedChild[]>()
  for (const child of nameChildren(db, taskId, children)) {
    const todoId = places.get(refKey(child)) ?? UNFILED_TODO_ID
    const group = groups.get(todoId) ?? []
    if (group.length === 0) groups.set(todoId, group)
    group.push(child)
  }
  const unfiled: ListedGroup = { todo: null, children: groups.get(UNFILED_TODO_ID) ?? [] }
  if (only === NO_TODO) return [unfiled]
  const listed = wanted.map((todo): ListedGroup => ({ todo, children: groups.get(todo.id) ?? [] }))
  return only === undefined ? [...listed, unfiled] : listed
}

function count(children: number): string {
  if (children === 0) return 'no children'
  return children === 1 ? '1 child:' : `${String(children)} children:`
}

/** What `list_children` tells the agent: a heading per group, with how many it holds, and a line per child. */
export function listingText(groups: readonly ListedGroup[]): string {
  return groups
    .flatMap(({ todo, children }) => [
      `${todo === null ? 'Not under a todo' : todoLabel(todo)}, ${count(children.length)}`,
      ...children.map((child) => {
        const follows = child.follows === null ? '' : ` (follows ${child.follows})`
        return `- ${childLabel(child)}${follows}`
      }),
    ])
    .join('\n')
}

/** A child the agent asks to file, once its id and its todo's have been read. */
interface Wanted {
  readonly id: ChildId
  readonly ref: ChildRef
  readonly todoId: TodoId
}

/**
 * Files children of a task under todos, as `file_children` asks: each from wherever it is, the placeholder included.
 * All of them or none.
 *
 * - A child that had a filing of its own is `moved`; one that had none (it was under no todo, or only followed its
 *   subagent) is `asked`: the agent filed it.
 * - A child already filed under the todo asked keeps its filing as it was, and nothing is written or sent for it.
 * - A child named twice for the same todo counts once.
 * - A subagent brings what it made, apart from anything filed on its own (`groupChildren`): those are answered as
 *   `brought`, and nothing is written for them.
 * - The windows hear the filings made, once (`filings.changed`).
 *
 * Fails, with nothing filed, while the hub is off (`invalid_transition`), and with `invalid_request` saying which when
 * a child's id names no child of the task (never given, or its child is gone: an artifact removed since), a todo isn't
 * in the task's list (never there, or deleted since), or a child is named twice for two todos.
 */
export function fileForAgent(
  context: FilingContext,
  taskId: string,
  requests: readonly FilingRequest[],
  now: EpochMs = Date.now(),
): FilingOutcome {
  const { db } = context
  requireTodoHub(db)
  const children = taskChildren(db, taskId)
  const todos = filingTodos(children.todos)
  const todoIds = new Set(todos.map(({ id }) => id))
  const all = childrenOf(children)
  const present = new Set(all.map(refKey))

  const unknown = new Set<string>()
  const gone = new Set<ChildId>()
  const noTodo = new Set<TodoId>()
  const twice = new Set<ChildId>()
  const wanted = new Map<ChildId, Wanted>()
  for (const request of requests) {
    const id = childIdOf(request.child)
    const todoId = todoIdOf(request.todo)
    const ref = childWithId(db, taskId, id)
    if (!todoIds.has(todoId)) noTodo.add(todoId)
    if (ref === undefined) {
      unknown.add(id)
    } else if (!present.has(refKey(ref))) {
      gone.add(id)
    } else if ((wanted.get(id)?.todoId ?? todoId) !== todoId) {
      twice.add(id)
    } else {
      wanted.set(id, { id, ref, todoId })
    }
  }
  const problem = (what: string, ids: ReadonlySet<string>): string[] =>
    ids.size === 0 ? [] : [`${what}: ${[...ids].join(', ')}.`]
  const problems = [
    ...problem('Not a child of this task', unknown),
    ...problem('No longer a child of this task (removed since it was listed)', gone),
    ...problem('Named for two todos in this call', twice),
    ...(unknown.size + gone.size === 0 ? [] : [LIST_FOR_IDS]),
    ...(noTodo.size === 0 ? [] : [noSuchTodo([...noTodo], todos)]),
  ]
  if (problems.length > 0) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, [NOTHING_FILED, ...problems].join(' '))
  }

  const own = ownFilings(children.filings)
  const filings: NewFiling[] = []
  const filed: FiledChild[] = []
  const unchanged: ChildId[] = []
  for (const { id, ref, todoId } of wanted.values()) {
    const had = own.get(refKey(ref))
    if (had?.todoId === todoId) {
      unchanged.push(id)
      continue
    }
    const source = had === undefined ? FilingSource.Asked : FilingSource.Moved
    filings.push({ kind: ref.kind, key: ref.key, todoId, source })
    filed.push({ id, todoId })
  }

  const before = placesOf(groupChildren(children))
  fileChildren(context, taskId, filings, now)
  const after = placesOf(groupChildren({ ...children, filings: listFilings(db, taskId) }))
  const named = new Set([...wanted.values()].map(({ ref }) => refKey(ref)))
  const moved = all.filter((ref) => !named.has(refKey(ref)) && before.get(refKey(ref)) !== after.get(refKey(ref)))
  const brought = identifyChildren(db, taskId, moved)
    .map(({ id }) => id)
    .sort(byNumber)
  return { filed, unchanged, brought }
}

/** What `file_children` tells the agent it did. */
export function filedText({ filed, unchanged, brought }: FilingOutcome): string {
  const byTodo = new Map<TodoId, ChildId[]>()
  for (const { id, todoId } of filed) byTodo.set(todoId, [...(byTodo.get(todoId) ?? []), id])
  const under = [...byTodo].map(([todoId, ids]) => `${ids.join(', ')} under #${todoId}`).join('; ')
  return [
    filed.length === 0 ? 'Nothing changed.' : `Filed ${count(filed.length)} ${under}.`,
    ...(brought.length === 0 ? [] : [`Moved with their subagent: ${brought.join(', ')}.`]),
    ...(unchanged.length === 0 ? [] : [`Already there: ${unchanged.join(', ')}.`]),
  ].join(' ')
}
