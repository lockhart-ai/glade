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
 * 09-todos.html shows it (3 of 7 done, one doing: 43% then 6%, about half of one item's 14%).
 */
export function progressBar({ done, doing, total }: TodoProgress): ProgressBar {
  if (total === 0) return { done: 0, doing: 0 }
  return { done: (done / total) * 100, doing: (doing / 2 / total) * 100 }
}

/** The groups the Todos tab shows the items in, in this order (#282). */
export enum TodoGroup {
  /** Being worked on, or waiting on you: in the agent's order. */
  Active = 'active',
  /** Done: the most recently finished first. */
  Completed = 'completed',
  /** Not started yet: in the agent's order. */
  NotStarted = 'not-started',
}

const GROUP_ORDER: readonly TodoGroup[] = [TodoGroup.Active, TodoGroup.Completed, TodoGroup.NotStarted]

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
  /** Its index in the agent's order, which keys it in the tab. */
  readonly position: number
}

/**
 * The items in the tab's order: active, then completed, then not started. Active and not-started items keep the agent's
 * order. Completed ones show the most recently finished first; of those finished at the same moment (several in one
 * call), the one further down the agent's list comes first, as the agent works down its list. A done item with no time
 * (main always gives one, but the type allows none) counts as the oldest.
 */
export function orderTodos(items: readonly Todo[]): readonly OrderedTodo[] {
  const rank = (todo: Todo) => GROUP_ORDER.indexOf(todoGroup(todo.state))
  return items
    .map((todo, position) => ({ todo, position }))
    .sort((a, b) => {
      const byGroup = rank(a.todo) - rank(b.todo)
      if (byGroup !== 0) return byGroup
      if (todoGroup(a.todo.state) !== TodoGroup.Completed) return a.position - b.position
      const byTime = (b.todo.completedAt ?? 0) - (a.todo.completedAt ?? 0)
      return byTime !== 0 ? byTime : b.position - a.position
    })
}
