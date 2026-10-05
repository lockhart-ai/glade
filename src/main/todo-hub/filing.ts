/**
 * Filing produced work under a todo as it's made (P16-04, #495; `docs/sdk-notes.md` §16), so nothing a task's agent
 * produces with the todo hub on is left under "Not under a todo": its artifacts and its commits. A subagent is filed
 * too, as plumbing: "this subagent works on this todo" is what its commits follow, and what its tab in the Agents tab
 * says (#536, `subagentTodo` in `src/shared/todoHub.ts`); it isn't produced work, and isn't shown under the todo.
 * **Watchers aren't filed at all:** a `Monitor`, background `Bash`, `ScheduleWakeup` or `CronCreate` call is left
 * exactly as it is, and nothing here reads, strips, asks about or holds a turn for one (`readsTodo`).
 *
 * The rule Jared picked from #492's findings, for an `Agent` call and for a `Bash` call that commits:
 *
 * 1. **The call names its todo:** `[todo N]` at the start of its description (`../agent/child-calls`). Glade reads
 *    the call twice (`callStarting`): as it streams, before its row is written to the tool log, and as it's about to
 *    run (the session's `PreToolUse` hook). It files what the call makes under that todo (`FilingSource.Named`), once,
 *    and takes the marker off the row and off the input the tool runs with, so it shows nowhere. A subagent is named
 *    by its call, so its todo is recorded before it exists; a commit is filed as it's found (`commitsLinked`).
 * 2. **A call that names none goes ahead,** and so does one whose marker names a todo that isn't in the task's list
 *    (the marker still comes off). Once the calls of its message have run (`batchFinished`, the `PostToolBatch` hook),
 *    Glade tells the agent what they made, by short id, and lists its todos (`askToFile`); the agent answers with one
 *    `file_children` call. What it's told of is recorded as owed (`owed_filings`) until it's filed.
 * 3. **A turn can't end with a filing owed** (`turnEnding`, the `Stop` hook): Glade holds the end, saying what's left
 *    (`holdToFile`), `MAX_HOLDS` times a turn at most, since Claude Code would hold for as long as it's told to. After
 *    that the turn ends, what's left stays under "Not under a todo", and the end of the next turn asks again.
 * 4. **Nothing is refused, and nothing is guessed** from which todo is in progress.
 * 5. **A subagent is never asked to file anything.** Its commits follow its todo by themselves (`groupChildren`),
 *    and so does a subagent it starts, unless that `Agent` call names another todo of the task's: then the subagent
 *    it starts works on that one. Nothing a subagent's call leaves unnamed is ever owed.
 *
 * An artifact has a tool of Glade's own, so its todo is a field: `add_artifact` needs one (`artifactTodo`,
 * `fileArtifact`).
 *
 * What's owed is only ever what the agent made itself, in a call: never what a task made before the hub, a link you
 * added by hand, or an artifact added through the control API, which wait under "Not under a todo" until someone asks
 * the agent to sort them.
 */
import type { Database } from 'better-sqlite3'
import type { Artifact, EpochMs, ToolInput } from '../../shared/domain'
import { isSubagentTool } from '../../shared/subagents'
import {
  childOfArtifact,
  childOfCommit,
  childOfSubagent,
  childrenOf,
  FilingSource,
  refKey,
  type ChildRef,
  type NewFiling,
  type TodoId,
} from '../../shared/todoHub'
import { FILE_CHILDREN_TOOL } from '../../shared/toolName'
import type { ChildCallStarting } from '../agent/backend'
import { namedTodo, readsTodo } from '../agent/child-calls'
import { listFilings } from '../db/repositories/child-filings'
import { listOwedFilings, oweFilings, settleOwedFilings } from '../db/repositories/owed-filings'
import { listCommitCalls } from '../db/repositories/task-commits'
import { getToolCall } from '../db/repositories/tool-events'
import { todoListFor } from '../todos/todos'
import {
  childLabel,
  filingTodos,
  nameSome,
  noSuchTodo,
  todoIdOf,
  todosLine,
  type FilingTodo,
  type NamedChild,
} from './agent-children'
import { fileChildren, taskChildren, unfileChildren, type FilingContext } from './todo-hub'

/** How many times Glade holds the end of one turn for filings owed, before it lets the turn end. */
export const MAX_HOLDS = 2

/** What `add_artifact` is refused with when it gives no todo; the task's todos follow. */
export const ARTIFACT_NEEDS_TODO =
  'Nothing was added: give the id of the todo this artifact belongs under, as todo (the N of Task #N).'

/** What a refused `add_artifact` call starts with when its todo isn't in the task's list. */
export const NOTHING_ADDED = 'Nothing was added.'

/** What Glade tells the agent, with their results, of what the calls of its message made that's under no todo. */
export function askToFile(made: readonly NamedChild[], todos: readonly FilingTodo[]): string {
  return [
    `Glade: file what you just made under its todo now, before your next step, with one ${FILE_CHILDREN_TOOL} call.`,
    'Made:',
    ...made.map((child) => `- ${childLabel(child)}`),
    todosLine(todos),
    ...(todos.length === 0 ? [] : ['If no todo fits, create it first with TaskCreate.']),
  ].join('\n')
}

/** Why Glade holds the end of a turn: what the agent still owes a filing for. */
export function holdToFile(owed: readonly NamedChild[], todos: readonly FilingTodo[]): string {
  return [
    `Glade: these aren't filed under a todo yet. File them with one ${FILE_CHILDREN_TOOL} call, then end your turn.`,
    ...owed.map((child) => `- ${childLabel(child)}`),
    todosLine(todos),
  ].join('\n')
}

/** The todos of a task that children can be filed under now. */
function todosOf(db: Database, taskId: string): FilingTodo[] {
  return filingTodos(todoListFor(db, taskId)?.items ?? [])
}

/**
 * The todo an `add_artifact` call files its artifact under, from what it gave as `todo` (`2`, or `#2`). Throws an
 * `Error`, for the tool to tell the model, when it gave none or one that isn't in the task's list (never there, or
 * deleted since): either says which todos the task has, or to create one first when it has none.
 */
export function artifactTodo(db: Database, taskId: string, given: string | undefined): TodoId {
  const todos = todosOf(db, taskId)
  if (given === undefined) throw new Error(`${ARTIFACT_NEEDS_TODO} ${todosLine(todos)}`)
  const todoId = todoIdOf(given)
  if (!todos.some(({ id }) => id === todoId)) throw new Error(`${NOTHING_ADDED} ${noSuchTodo([todoId], todos)}`)
  return todoId
}

/**
 * Files an artifact the agent declared under the todo its call named: `Named` the first time, and `Moved` when it was
 * declared before under another todo. One already under that todo keeps its filing as it was, and nothing is written
 * or sent.
 */
export function fileArtifact(
  context: FilingContext,
  taskId: string,
  artifact: Artifact,
  todoId: TodoId,
  now: EpochMs = Date.now(),
): void {
  const child = childOfArtifact(artifact)
  const had = listFilings(context.db, taskId).find((filing) => refKey(filing) === refKey(child))
  if (had?.todoId === todoId) return
  const source = had === undefined ? FilingSource.Named : FilingSource.Moved
  fileChildren(context, taskId, [{ ...child, todoId, source }], now)
}

/** The subagent an `Agent` call starts: named by the call itself, so its todo is recorded before it exists. */
function subagentOf(toolUseId: string): ChildRef {
  return childOfSubagent({ toolUseId })
}

/** A call as the filer is told of it: the tool, its input and its id, and whether a subagent made it. */
export interface FiledCall extends Pick<ChildCallStarting, 'toolName' | 'input' | 'toolUseId'> {
  /** Whether one of the task's subagents made the call, not its own agent. */
  readonly subagent: boolean
}

/** Files the commits a task's agent makes, and records its subagents' todos: see the module comment. */
export interface ChildFiler {
  /**
   * A call was written, or is about to run: Glade is told of each call at both moments, in either order. Answers the
   * call's input with the todo's marker taken off; null for a call with no marker, and for one Glade reads no todo off
   * (`readsTodo`: a watcher's, say), which stays exactly as it is.
   *
   * - The agent's own call whose marker names a todo of the task files what it makes under that todo, the first time
   *   it's seen to (a todo made by an earlier call of the same message may only be in the list the second time); any
   *   other call of its own is remembered as naming none, to be asked about.
   * - A subagent's `Agent` call whose marker names a todo of the task has the subagent it starts work on that todo;
   *   any other leaves it on its parent's, and is never asked about.
   */
  callStarting(taskId: string, call: FiledCall): ToolInput | null
  /** Commits were linked to a task's `Bash` call: one that named a todo has them filed under it, there and then. */
  commitsLinked(taskId: string, toolUseId: string): void
  /**
   * The calls of one of the agent's own messages have run (the ones a todo is read off, by their `tool_use` ids).
   * Answers what to tell the agent: the subagents and commits they made that are under no todo (`askToFile`); null
   * when there's nothing to file.
   */
  batchFinished(taskId: string, toolUseIds: readonly string[]): string | null
  /**
   * The agent is about to end its turn; `held` is whether this turn's end was held before. Answers why it can't end
   * yet (`holdToFile`), or null to let it: nothing is owed, or the turn has been held `MAX_HOLDS` times.
   */
  turnEnding(taskId: string, held: boolean): string | null
  /** The task's session is gone: the calls it was running will never finish, and its turn is over. */
  sessionEnded(taskId: string): void
}

/** What a `ChildFiler` needs: where filings go, and the clock (`Date.now` by default). */
export interface ChildFilerOptions extends FilingContext {
  readonly now?: () => EpochMs
}

export function createChildFiler({ db, emit, now = Date.now }: ChildFilerOptions): ChildFiler {
  const context: FilingContext = { db, emit }
  /**
   * Each task's own calls a todo is read off that are running, or whose message hasn't finished: the todo each
   * named, or null for none.
   */
  const calls = new Map<string, Map<string, TodoId | null>>()
  /** How many times each task's turn has been held at its end. */
  const holds = new Map<string, number>()

  const callsOf = (taskId: string): Map<string, TodoId | null> => {
    let running = calls.get(taskId)
    if (running === undefined) {
      running = new Map()
      calls.set(taskId, running)
    }
    return running
  }

  /** The commits each of a task's calls made, oldest first. */
  const commitsByCall = (taskId: string): Map<string, ChildRef[]> => {
    const commits = new Map<string, ChildRef[]>()
    for (const commit of listCommitCalls(db, taskId)) {
      commits.set(commit.toolUseId, [...(commits.get(commit.toolUseId) ?? []), childOfCommit(commit)])
    }
    return commits
  }

  /**
   * Settles calls that have run: files the commits a call that named a todo made and weren't filed as they were found,
   * takes back the todo of a subagent such a call never started (it failed, or was refused), and records what the
   * others made as owed. Answers the children newly owed, in the order they were made.
   */
  const settle = (taskId: string, toolUseIds: readonly string[]): ChildRef[] => {
    const running = callsOf(taskId)
    const filed = new Map(listFilings(db, taskId).map((filing) => [refKey(filing), filing]))
    const commits = commitsByCall(taskId)
    const owed: ChildRef[] = []
    const filings: NewFiling[] = []
    const never: ChildRef[] = []
    for (const toolUseId of toolUseIds) {
      const todoId = running.get(toolUseId) ?? null
      running.delete(toolUseId)
      const call = getToolCall(db, taskId, toolUseId)
      const subagent = subagentOf(toolUseId)
      const started = call !== undefined && isSubagentTool(call.name)
      const made = [...(started ? [subagent] : []), ...(commits.get(toolUseId) ?? [])]
      const unfiled = made.filter((child) => !filed.has(refKey(child)))
      if (todoId === null) {
        owed.push(...unfiled)
        continue
      }
      filings.push(...unfiled.map((child) => ({ ...child, todoId, source: FilingSource.Named })))
      if (!started && filed.has(refKey(subagent))) never.push(subagent)
    }
    fileChildren(context, taskId, filings, now())
    unfileChildren(context, taskId, never)
    if (owed.length > 0) oweFilings(db, taskId, owed, now())
    return owed
  }

  return {
    callStarting(taskId, { toolName, input, toolUseId, subagent }) {
      if (!readsTodo({ toolName, input, subagent })) return null
      const named = namedTodo(toolName, input)
      if (subagent) {
        // A subagent's subagent works on its parent's todo, unless its call names another of the task's: nothing is
        // remembered of the call, and nothing of it is ever owed.
        if (named === null) return null
        const started = subagentOf(toolUseId)
        const isFiled = listFilings(db, taskId).some((filing) => refKey(filing) === refKey(started))
        if (!isFiled && todosOf(db, taskId).some(({ id }) => id === named.todoId)) {
          fileChildren(context, taskId, [{ ...started, todoId: named.todoId, source: FilingSource.Named }], now())
        }
        return named.input
      }
      const running = callsOf(taskId)
      // Told of before, with its todo: there's nothing more to file.
      const known = running.get(toolUseId) ?? null
      if (named === null || known !== null) {
        if (named === null) running.set(toolUseId, null)
        return named?.input ?? null
      }
      const todoId = todosOf(db, taskId).some(({ id }) => id === named.todoId) ? named.todoId : null
      running.set(toolUseId, todoId)
      // A subagent's todo is recorded there and then; a `Bash` call's commits are filed as they're found.
      if (todoId !== null && isSubagentTool(toolName)) {
        fileChildren(context, taskId, [{ ...subagentOf(toolUseId), todoId, source: FilingSource.Named }], now())
      }
      return named.input
    },

    commitsLinked(taskId, toolUseId) {
      const todoId = calls.get(taskId)?.get(toolUseId) ?? null
      if (todoId === null) return
      const filed = new Set(listFilings(db, taskId).map(refKey))
      const commits = (commitsByCall(taskId).get(toolUseId) ?? []).filter((commit) => !filed.has(refKey(commit)))
      fileChildren(
        context,
        taskId,
        commits.map((commit) => ({ ...commit, todoId, source: FilingSource.Named })),
        now(),
      )
    },

    batchFinished(taskId, toolUseIds) {
      if (toolUseIds.length === 0) return null
      const owed = settle(taskId, toolUseIds)
      if (owed.length === 0) return null
      const children = taskChildren(db, taskId)
      return askToFile(nameSome(db, taskId, children, owed), filingTodos(children.todos))
    },

    turnEnding(taskId, held) {
      if (!held) holds.delete(taskId)
      // The calls of a message that never finished (a turn you stopped, say): what they made is owed too.
      const unsettled = [...(calls.get(taskId)?.keys() ?? [])]
      if (unsettled.length > 0) settle(taskId, unsettled)
      const recorded = listOwedFilings(db, taskId)
      if (recorded.length === 0) return null
      const children = taskChildren(db, taskId)
      const present = new Set(childrenOf(children).map(refKey))
      const gone = recorded.filter((child) => !present.has(refKey(child)))
      // A child that's gone (a commit amended away) is owed nothing.
      if (gone.length > 0) settleOwedFilings(db, taskId, gone)
      const owed = recorded.filter((child) => present.has(refKey(child)))
      const count = holds.get(taskId) ?? 0
      if (owed.length === 0 || count >= MAX_HOLDS) return null
      holds.set(taskId, count + 1)
      return holdToFile(nameSome(db, taskId, children, owed), filingTodos(children.todos))
    },

    sessionEnded(taskId) {
      calls.delete(taskId)
      holds.delete(taskId)
    },
  }
}
