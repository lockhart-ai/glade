import { faMagnifyingGlass, faPlus } from '@fortawesome/free-solid-svg-icons'
import { useMemo } from 'react'
import { needsYou, parseTaskFilter, TaskFilter } from '../../shared/attention'
import { UiStateKey, type Task } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Button, ButtonVariant, Input } from '../components'
import { useGladeStore } from '../store/react'
import { useNewTask } from './useNewTask'
import styles from './TaskListToolbar.module.css'

export interface TaskListToolbarProps {
  /** The workspace new tasks are created in and the counts are taken from. */
  workspaceId: string
}

interface ChipCounts {
  readonly needsYou: number
  readonly unread: number
}

function countChips(tasks: Iterable<Task>, workspaceId: string): ChipCounts {
  let needs = 0
  let unread = 0
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId) continue
    if (needsYou(task)) needs += 1
    if (task.unread) unread += 1
  }
  return { needsYou: needs, unread }
}

interface ChipProps {
  filter: TaskFilter
  chosen: TaskFilter
  onChoose: (filter: TaskFilter) => void
  children: React.ReactNode
}

/** One filter chip: pressed while its filter is the chosen one. */
function Chip({ filter, chosen, onChoose, children }: ChipProps): React.JSX.Element {
  const on = filter === chosen
  return (
    <button
      type="button"
      aria-pressed={on}
      className={classNames(styles.chip, on && styles.chipOn)}
      onClick={() => {
        onChoose(filter)
      }}
    >
      {children}
    </button>
  )
}

/**
 * Above the task list: the search field and the New task button, then the All · Needs you · Unread filter chips, which
 * filter the task list and remember the choice. The search field doesn't filter yet.
 */
export function TaskListToolbar({ workspaceId }: TaskListToolbarProps): React.JSX.Element {
  const tasks = useGladeStore((state) => state.tasks)
  const newTask = useNewTask(workspaceId)
  const counts = useMemo(() => countChips(Object.values(tasks), workspaceId), [tasks, workspaceId])
  const chosen = useGladeStore((state) => parseTaskFilter(state.uiState[UiStateKey.TaskFilter]))
  const setUiState = useGladeStore((state) => state.setUiState)
  const choose = (filter: TaskFilter): void => {
    if (filter !== chosen) void setUiState({ key: UiStateKey.TaskFilter, value: filter })
  }

  return (
    <div className={styles.toolbar}>
      <div className={styles.searchRow}>
        <Input
          type="search"
          label="Search tasks"
          placeholder="Search"
          icon={faMagnifyingGlass}
          className={styles.search}
        />
        <Button
          variant={ButtonVariant.Dark}
          icon={faPlus}
          aria-label="New task"
          title="New task (⌘N)"
          className={styles.newTask}
          onClick={() => void newTask()}
        />
      </div>
      <div className={styles.chips} role="group" aria-label="Filter tasks">
        <Chip filter={TaskFilter.All} chosen={chosen} onChoose={choose}>
          All
        </Chip>
        <Chip filter={TaskFilter.NeedsYou} chosen={chosen} onChoose={choose}>
          Needs you<span className={classNames(styles.count, styles.needsYou)}>{counts.needsYou}</span>
        </Chip>
        <Chip filter={TaskFilter.Unread} chosen={chosen} onChoose={choose}>
          Unread<span className={classNames(styles.count, styles.unread)}>{counts.unread}</span>
        </Chip>
      </div>
    </div>
  )
}
