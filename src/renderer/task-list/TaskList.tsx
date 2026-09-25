import { faChevronDown, faChevronRight, faThumbtack } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { parseTaskFilter, TaskFilter } from '../../shared/attention'
import { UiStateKey, type Task } from '../../shared/domain'
import { doneTotal, inDoneList } from '../../shared/doneList'
import { WindowCommandId } from '../../shared/commands'
import { useCommands } from '../commands/hooks'
import { Icon, IconSize, useToast } from '../components'
import { ContextMenu, useContextMenu } from '../context-menus'
import { doneCountsFor, doneListKey, isLoaded } from '../store/doneLists'
import { describeFailure } from '../store/hydrate'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import {
  collapsedValue,
  collapseKey,
  isCollapsed,
  listedTaskIds,
  listSections,
  nextNeedingYou,
  SectionId,
  sectionTasks,
  Step,
  stepSelection,
  type TaskSection,
} from './sections'
import { DoneRows } from './DoneRows'
import { TaskRow } from './TaskRow'
import { useRenameTask } from './useRenameTask'
import { useTaskMenu } from './useTaskMenu'
import styles from './TaskList.module.css'
import { useNow } from './useNow'

export interface TaskListProps {
  /** The workspace whose tasks to list. */
  workspaceId: string
}

function sectionTitle(id: SectionId): string {
  switch (id) {
    case SectionId.Pinned:
      return 'Pinned'
    case SectionId.Active:
      return 'Active'
    case SectionId.Done:
      return 'Done'
  }
}

/** Whether `row` shows whole within the list's visible area. */
function inView(row: Element, list: Element): boolean {
  const box = row.getBoundingClientRect()
  const view = list.getBoundingClientRect()
  return box.top >= view.top && box.bottom <= view.bottom
}

/**
 * A workspace's tasks in the Pinned, Active and Done sections, kept live from the store, narrowed to the filter chosen
 * with the chips above (`TaskListToolbar`); each section counts the tasks it shows. Each section collapses, and
 * remembers it. Clicking a row selects its task; ⌥↑ / ⌥↓ move the selection through the expanded sections, and ⌘⌥↓
 * jumps to the next task that needs you. The selected task scrolls into view. The task being renamed (F2) shows a text
 * field for its title in its row. Right-clicking a row, or ⇧F10 on it, opens the task's context menu.
 *
 * The Done section can hold thousands of tasks, so it loads from main a page at a time as you scroll down it (or step
 * past its last loaded row, or select a task further down), and renders only the rows in view (`DoneRows`).
 */
export function TaskList({ workspaceId }: TaskListProps): React.JSX.Element {
  const store = useGladeStoreApi()
  const tasks = useGladeStore((state) => state.tasks)
  const doneLists = useGladeStore((state) => state.doneLists)
  const uiState = useGladeStore((state) => state.uiState)
  const selectedTaskId = useGladeStore((state) => state.selectedTaskId)
  const selectTask = useGladeStore((state) => state.selectTask)
  const loadDonePage = useGladeStore((state) => state.loadDonePage)
  const loadDoneThrough = useGladeStore((state) => state.loadDoneThrough)
  const doneCounts = useGladeStore((state) => doneCountsFor(state, workspaceId))
  const { renamingTaskId, rename, cancelRename } = useRenameTask()
  const setUiState = useGladeStore((state) => state.setUiState)
  const now = useNow()
  const menu = useContextMenu<string>()
  const taskMenu = useTaskMenu()
  const toast = useToast()
  // The scroller, as state rather than a ref: the Done section's rows can only lay out once it's mounted.
  const [list, setList] = useState<HTMLDivElement | null>(null)

  const filter = parseTaskFilter(uiState[UiStateKey.TaskFilter])
  const sections = useMemo(
    () => listSections({ tasks, doneLists, uiState }, workspaceId, filter),
    [tasks, doneLists, uiState, workspaceId, filter],
  )
  const donePages = doneLists[doneListKey(workspaceId, filter)]

  const fail = useCallback(
    (error: unknown): void => {
      toast.show({ message: describeFailure(error) })
    },
    [toast],
  )

  // The Done section's first page, for a workspace or filter chip it hasn't loaded under yet.
  const doneUnloaded = donePages === undefined
  useEffect(() => {
    if (doneUnloaded) loadDonePage(workspaceId, filter).catch(fail)
  }, [doneUnloaded, workspaceId, filter, loadDonePage, fail])

  // A selected done task below the pages loaded (restored, or opened from a link) loads down to its row.
  const selectedTask = selectedTaskId === null ? undefined : tasks[selectedTaskId]
  const selectedBelow =
    selectedTask !== undefined && inDoneList(selectedTask, workspaceId, filter) && !isLoaded(selectedTask, donePages)
  useEffect(() => {
    if (selectedBelow && selectedTaskId !== null) loadDoneThrough(workspaceId, filter, selectedTaskId).catch(fail)
  }, [selectedBelow, selectedTaskId, workspaceId, filter, loadDoneThrough, fail])

  // The selected task's row scrolls into view, if it's off screen. (The Done section's rows do this themselves.)
  useEffect(() => {
    if (list === null || selectedTaskId === null) return
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-task-id]'))
    const row = rows.find(({ dataset }) => dataset.taskId === selectedTaskId)
    if (row !== undefined && !inView(row, list)) row.scrollIntoView({ block: 'nearest' })
  }, [list, selectedTaskId])

  // ⌥↓ past the last loaded done task loads the next page first, and ⌥↑ with nothing selected goes to the very last.
  const step = async (direction: Step): Promise<void> => {
    const state = store.getState()
    const shown = parseTaskFilter(state.uiState[UiStateKey.TaskFilter])
    const order = listedTaskIds(state, workspaceId)
    const index = state.selectedTaskId === null ? -1 : order.indexOf(state.selectedTaskId)
    if (!isCollapsed(state.uiState, SectionId.Done)) {
      if (direction === Step.Next && index !== -1 && index === order.length - 1) {
        await loadDonePage(workspaceId, shown)
      } else if (direction === Step.Previous && index === -1) {
        await loadDoneThrough(workspaceId, shown, null)
      }
    }
    const after = store.getState()
    const next = stepSelection(listedTaskIds(after, workspaceId), after.selectedTaskId, direction)
    if (next !== null && next !== after.selectedTaskId) await selectTask(next)
  }
  useCommands({
    [WindowCommandId.NextTask]: () => {
      step(Step.Next).catch(fail)
    },
    [WindowCommandId.PreviousTask]: () => {
      step(Step.Previous).catch(fail)
    },
    [WindowCommandId.NextTaskNeedingYou]: () => {
      const next = nextNeedingYou(sectionTasks(Object.values(tasks), workspaceId, TaskFilter.All), selectedTaskId)
      if (next !== null) void selectTask(next)
    },
  })

  const select = (taskId: string): void => {
    void selectTask(taskId)
  }
  const row = (task: Task): React.JSX.Element => (
    <TaskRow
      task={task}
      now={now}
      selected={task.id === selectedTaskId}
      onSelect={select}
      renaming={task.id === renamingTaskId}
      onRename={rename}
      onCancelRename={cancelRename}
      menuTarget={menu.targetProps(task.id)}
    />
  )
  const loadMore = useCallback(() => {
    loadDonePage(workspaceId, filter).catch(fail)
  }, [loadDonePage, workspaceId, filter, fail])

  return (
    <div className={styles.list} ref={setList}>
      {sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          count={section.id === SectionId.Done ? doneTotal(doneCounts, filter) : section.tasks.length}
          collapsed={isCollapsed(uiState, section.id)}
          onToggle={(collapsed) => {
            void setUiState({ key: collapseKey(section.id), value: collapsedValue(collapsed) })
          }}
        >
          {(listId) =>
            section.id === SectionId.Done ? (
              <DoneRows
                listId={listId}
                tasks={section.tasks}
                hasMore={donePages?.hasMore ?? false}
                scroller={list}
                onEndReached={loadMore}
                selectedTaskId={selectedTaskId}
                row={row}
              />
            ) : (
              <ul id={listId} className={styles.rows}>
                {section.tasks.map((task) => (
                  <li key={task.id} data-task-id={task.id}>
                    {row(task)}
                  </li>
                ))}
              </ul>
            )
          }
        </Section>
      ))}
      <ContextMenu label="Task actions" state={menu} entries={taskMenu} />
    </div>
  )
}

interface SectionProps {
  section: TaskSection
  /** How many tasks it holds: the Done section's, as main counts them, however many have loaded. */
  count: number
  collapsed: boolean
  onToggle: (collapsed: boolean) => void
  /** Its rows, in a list with the id the header controls. */
  children: (listId: string) => React.ReactNode
}

/** A section header (chevron, name, count) that collapses the rows below it. */
function Section({ section, count, collapsed, onToggle, children }: SectionProps): React.JSX.Element {
  const listId = useId()
  const title = sectionTitle(section.id)
  return (
    <section className={styles.section} aria-label={title}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : listId}
        onClick={() => {
          onToggle(!collapsed)
        }}
      >
        <span className={styles.chevron}>
          <Icon icon={collapsed ? faChevronRight : faChevronDown} size={IconSize.Small} />
        </span>
        <span className={styles.name}>
          {section.id === SectionId.Pinned && <Icon icon={faThumbtack} className={styles.pin} />}
          {title}
        </span>
        <span>{count}</span>
      </button>
      {!collapsed && children(listId)}
    </section>
  )
}
