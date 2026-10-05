/** What the Todos tab shows, worked out from a task's todo list: the progress, its heading and bar, and the items' order. */
import { TodoState, type Todo } from '../../shared/domain'
import type { TodoProgress } from '../../shared/todoSummary'

export { todoProgress, type TodoProgress } from '../../shared/todoSummary'

/** The tab's heading: `3 of 7 done`. */
export function progressHeading({ done, total }: TodoProgress): string {
  return `${String(done)} of ${String(total)} done`
}

/** How much of the progress bar each part fills, in percent. */
export interface ProgressBar {
  readonly done: number
  /** After the done part, in blue. */
  readonly doing: number
}

/**
 * The progress bar: the done items' share of the list, then half an item's share for each item being worked on, as
 * 46-todo-hub.html shows it (with 3 of 7 done and one doing: 43% then 6%, about half of one item's 14%).
 */
export function progressBar({ done, doing, total }: TodoProgress): ProgressBar {
  if (total === 0) return { done: 0, doing: 0 }
  return { done: (done / total) * 100, doing: (doing / 2 / total) * 100 }
}

/** The groups the Todos tab shows the items in, in this order: what's still to do before what's done (#282, #322). */
export enum TodoGroup {
  /** Being worked on, or waiting on you: in the agent's order. */
  Active = 'active',
  /** Not started yet: in the agent's order. */
  NotStarted = 'not-started',
  /** Done: the most recently finished first. */
  Completed = 'completed',
}

const GROUP_ORDER: readonly TodoGroup[] = [TodoGroup.Active, TodoGroup.NotStarted, TodoGroup.Completed]

/** Which group an item's state puts it in. */
export function todoGroup(state: TodoState): TodoGroup {
  switch (state) {
    case TodoState.Doing:
    case TodoState.Waiting:
      return TodoGroup.Active
    case TodoState.Done:
      return TodoGroup.Completed
    case TodoState.Todo:
      return TodoGroup.NotStarted
  }
}

/** An item where the tab shows it, with its place in the agent's list. */
export interface OrderedTodo {
  readonly todo: Todo
  /** Its index in the agent's order. */
  readonly position: number
  /**
   * What keys its row in the tab: its id (`Todo.id`, Claude Code's own), so a row stays the same row as the list around
   * it changes. An item with no id (`TodoWrite`'s) is keyed by its place in the list instead, and so is one whose id an
   * earlier item already has, which Claude Code never gives, so no two rows ever share a key.
   */
  readonly key: string
}

/**
 * The items in the tab's order: active, then not started, then completed. Active and not-started items keep the agent's
 * order. Completed ones show the most recently finished first; of those finished at the same moment (several in one
 * call), the one further down the agent's list comes first, as the agent works down its list. A done item with no time
 * (main always gives one, but the type allows none) counts as the oldest.
 */
export function orderTodos(items: readonly Todo[]): readonly OrderedTodo[] {
  const rank = (todo: Todo) => GROUP_ORDER.indexOf(todoGroup(todo.state))
  const taken = new Set<string>()
  const keyOf = ({ id }: Todo, position: number): string => {
    if (id === null || taken.has(id)) return `at:${String(position)}`
    taken.add(id)
    return `id:${id}`
  }
  return items
    .map((todo, position) => ({ todo, position, key: keyOf(todo, position) }))
    .sort((a, b) => {
      const byGroup = rank(a.todo) - rank(b.todo)
      if (byGroup !== 0) return byGroup
      if (todoGroup(a.todo.state) !== TodoGroup.Completed) return a.position - b.position
      const byTime = (b.todo.completedAt ?? 0) - (a.todo.completedAt ?? 0)
      return byTime !== 0 ? byTime : b.position - a.position
    })
}
