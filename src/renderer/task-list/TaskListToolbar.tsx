import { faMagnifyingGlass, faPlus } from '@fortawesome/free-solid-svg-icons'
import { useMemo } from 'react'
import type { Task } from '../../shared/domain'
import { TaskIndicator, taskIndicator } from '../../shared/taskIndicator'
import { classNames } from '../components/classNames'
import { Button, ButtonVariant, Input, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
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
  let needsYou = 0
  let unread = 0
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId) continue
    if (taskIndicator(task) === TaskIndicator.Waiting) needsYou += 1
    if (task.unread) unread += 1
  }
  return { needsYou, unread }
}

/**
 * Above the task list: the search field and the New task button, then the All · Needs you · Unread filter chips. The
 * search field and the chips don't filter yet.
 */
export function TaskListToolbar({ workspaceId }: TaskListToolbarProps): React.JSX.Element {
  const tasks = useGladeStore((state) => state.tasks)
  const createTask = useGladeStore((state) => state.createTask)
  const toast = useToast()
  const counts = useMemo(() => countChips(Object.values(tasks), workspaceId), [tasks, workspaceId])

  const newTask = async (): Promise<void> => {
    try {
      await createTask(workspaceId)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
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
        <button type="button" aria-pressed="true" className={classNames(styles.chip, styles.chipOn)}>
          All
        </button>
        <button type="button" aria-pressed="false" className={styles.chip}>
          Needs you<span className={classNames(styles.count, styles.needsYou)}>{counts.needsYou}</span>
        </button>
        <button type="button" aria-pressed="false" className={styles.chip}>
          Unread<span className={classNames(styles.count, styles.unread)}>{counts.unread}</span>
        </button>
      </div>
    </div>
  )
}
