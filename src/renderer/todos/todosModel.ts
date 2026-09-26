/** What the Todos tab shows, worked out from a task's todo list: the progress, its heading and its bar. */
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
