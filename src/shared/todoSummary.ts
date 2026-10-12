/**
 * A task's todo list in brief, as its row in the task list shows it (#246): the `3/7` and its ring, a check once every
 * item is done, and a tooltip naming what the agent is working on now. Main works the summary out from the same todo
 * list the Todos tab shows, and keeps it on the task, so the row and the tab never disagree.
 */
import { TodoState, type TodoList, type TodoSummary } from './domain'

/** How far through its list the agent is: the Todos tab's `3/7`. */
export interface TodoProgress {
  readonly done: number
  readonly total: number
  /** Items being worked on now. */
  readonly doing: number
}

/**
 * The list's progress, as the Todos tab counts it; none of none when there's no list. A stranded item (#593) is left
 * out of every count: the heading, the bar and the tab's own badge count the live todos alone, as the approved mockup
 * draws it. A list `refreshTodos` works out for the task row never marks one stranded, so this never changes what the
 * row counts.
 */
export function todoProgress(list: TodoList | null | undefined): TodoProgress {
  const items = (list?.items ?? []).filter((item) => item.stranded !== true)
  return {
    done: items.filter(({ state }) => state === TodoState.Done).length,
    doing: items.filter(({ state }) => state === TodoState.Doing).length,
    total: items.length,
  }
}

/**
 * The list in brief, counted as the Todos tab counts it (`todoProgress`, stranded items left out); null for no list, or
 * one with nothing left to count, which the row shows nothing for.
 */
export function summarizeTodos(list: TodoList | null): TodoSummary | null {
  if (list === null || list.items.length === 0) return null
  const { done, total } = todoProgress(list)
  if (total === 0) return null
  const doing = list.items
    .filter(({ state, stranded }) => state === TodoState.Doing && stranded !== true)
    .map(({ text }) => text)
  return { done, total, doing }
}

/** Whether every item on the list is done: the row shows a check. */
export function allTodosDone({ done, total }: TodoSummary): boolean {
  return done === total
}

/** What the row's progress says to a screen reader and in its tooltip: `3 of 7 todos done · Now: Copy the files`. */
export function todoSummaryLabel(summary: TodoSummary): string {
  const progress = `${String(summary.done)} of ${String(summary.total)} todos done`
  return summary.doing.length === 0 ? progress : `${progress} · Now: ${summary.doing.join('; ')}`
}

/** Whether two summaries say the same, so a task whose summary didn't change isn't told to the windows again. */
export function sameTodoSummary(a: TodoSummary | null, b: TodoSummary | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.done === b.done &&
    a.total === b.total &&
    a.doing.length === b.doing.length &&
    a.doing.every((text, index) => text === b.doing[index])
  )
}
