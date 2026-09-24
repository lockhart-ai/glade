import { matchesFilter, TaskFilter } from '../../shared/attention'
import { TaskState, UiStateKey, type Task, type UiStateEntry } from '../../shared/domain'
import type { UiStateValues } from '../store/state'

/** The task list's sections, in the order they appear. */
export enum SectionId {
  Pinned = 'pinned',
  Active = 'active',
  Done = 'done',
}

export const SECTION_ORDER: readonly SectionId[] = [SectionId.Pinned, SectionId.Active, SectionId.Done]

/** One section of the task list and its tasks, most recently updated first. */
export interface TaskSection {
  readonly id: SectionId
  readonly tasks: readonly Task[]
}

/** Each section's persisted collapse key and whether it starts collapsed (the design shows Done collapsed). */
interface SectionCollapse {
  readonly key: UiStateKey
  readonly collapsedByDefault: boolean
}

function sectionCollapse(id: SectionId): SectionCollapse {
  switch (id) {
    case SectionId.Pinned:
      return { key: UiStateKey.PinnedSectionCollapsed, collapsedByDefault: false }
    case SectionId.Active:
      return { key: UiStateKey.ActiveSectionCollapsed, collapsedByDefault: false }
    case SectionId.Done:
      return { key: UiStateKey.DoneSectionCollapsed, collapsedByDefault: true }
  }
}

/** The UI state key that stores whether a section is collapsed. */
export function collapseKey(id: SectionId): UiStateKey {
  return sectionCollapse(id).key
}

/** Whether a section is collapsed, from the persisted UI state or else its default. */
export function isCollapsed(uiState: UiStateValues, id: SectionId): boolean {
  const { key, collapsedByDefault } = sectionCollapse(id)
  const value = uiState[key]
  return value === undefined ? collapsedByDefault : value === 'true'
}

/** The stored value for a section's collapse state. */
export function collapsedValue(collapsed: boolean): string {
  return collapsed ? 'true' : 'false'
}

/**
 * What to write so a task that was just marked done stays in view: Done expanded, as a manual expand would store it.
 * Null when there's nothing to do: the task stays under Pinned, or Done is already open.
 */
export function revealDone(task: Pick<Task, 'pinned'>, uiState: UiStateValues): UiStateEntry | null {
  if (task.pinned || !isCollapsed(uiState, SectionId.Done)) return null
  return { key: collapseKey(SectionId.Done), value: collapsedValue(false) }
}

function sectionOf(task: Pick<Task, 'pinned' | 'state'>): SectionId {
  if (task.pinned) return SectionId.Pinned
  switch (task.state) {
    case TaskState.Active:
      return SectionId.Active
    case TaskState.Done:
      return SectionId.Done
  }
}

/** Most recently updated first; ties by id, so the order is stable. */
function byRecency(a: Task, b: Task): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
}

/**
 * Splits a workspace's tasks that pass the filter into the Pinned, Active and Done sections, each most recently updated
 * first. A pinned task appears only under Pinned, whatever its state.
 */
export function sectionTasks(
  tasks: Iterable<Task>,
  workspaceId: string,
  filter: TaskFilter = TaskFilter.All,
): TaskSection[] {
  const grouped = new Map<SectionId, Task[]>(SECTION_ORDER.map((id) => [id, []]))
  for (const task of tasks) {
    if (task.workspaceId === workspaceId && matchesFilter(task, filter)) grouped.get(sectionOf(task))?.push(task)
  }
  return SECTION_ORDER.map((id) => ({ id, tasks: (grouped.get(id) ?? []).sort(byRecency) }))
}

/** The ids of the tasks in the sections that aren't collapsed, top to bottom: the order ⌥↑ and ⌥↓ move through. */
export function visibleTaskIds(sections: readonly TaskSection[], uiState: UiStateValues): string[] {
  return sections.filter(({ id }) => !isCollapsed(uiState, id)).flatMap(({ tasks }) => tasks.map((task) => task.id))
}

/** Which way ⌥↑ / ⌥↓ moves the selection. */
export enum Step {
  Previous = 'previous',
  Next = 'next',
}

function offset(step: Step): number {
  switch (step) {
    case Step.Previous:
      return -1
    case Step.Next:
      return 1
  }
}

/**
 * The task to select after moving one step from `selectedId` through `order`: the next or previous one, staying put at
 * either end. With nothing (or a hidden task) selected, Next goes to the first task and Previous to the last. Null
 * when there's nothing to select.
 */
export function stepSelection(order: readonly string[], selectedId: string | null, step: Step): string | null {
  if (order.length === 0) return null
  const index = selectedId === null ? -1 : order.indexOf(selectedId)
  if (index === -1) return (step === Step.Next ? order[0] : order[order.length - 1]) ?? null
  return order[Math.min(Math.max(index + offset(step), 0), order.length - 1)] ?? null
}
