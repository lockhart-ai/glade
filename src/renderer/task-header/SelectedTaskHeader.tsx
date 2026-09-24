import { faCheck, faThumbtack } from '@fortawesome/free-solid-svg-icons'
import type { ReactNode } from 'react'
import { TaskState, type Task } from '../../shared/domain'
import { taskIndicator } from '../../shared/taskIndicator'
import { Button, ButtonVariant, Pill, useToast } from '../components'
import { TaskHeader } from '../layout'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import { useNow } from '../task-list/useNow'
import { EMPTY_OBJECTIVE, EMPTY_STATUS, EMPTY_TITLE, formatAgo, isNewTask, pillLabel, timing } from './headerModel'
import styles from './SelectedTaskHeader.module.css'

interface FieldRowProps {
  readonly label: string
  readonly className: string | undefined
  readonly children: ReactNode
}

/** One labelled row under the divider: Objective, then Status (Outcome once the task is done). */
function FieldRow({ label, className, children }: FieldRowProps): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className={styles.row}>
      <div className={styles.label} aria-hidden>
        {label}
      </div>
      <p className={className}>{children}</p>
    </div>
  )
}

/** A field the agent hasn't set yet. */
function Empty({ children }: { readonly children: string }): React.JSX.Element {
  return <span className={styles.empty}>{children}</span>
}

interface HeaderProps {
  readonly task: Task
}

function Header({ task }: HeaderProps): React.JSX.Element {
  const now = useNow()
  const updateTask = useGladeStore((state) => state.updateTask)
  const markTaskDone = useGladeStore((state) => state.markTaskDone)
  const toast = useToast()
  const done = task.state === TaskState.Done

  const run = async (action: Promise<void>): Promise<void> => {
    try {
      await action
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
  }
  const pinLabel = task.pinned ? 'Unpin task' : 'Pin task'

  return (
    <>
      <div className={styles.top}>
        <div className={styles.heading}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{task.title === '' ? <Empty>{EMPTY_TITLE}</Empty> : task.title}</h1>
            <Button
              variant={ButtonVariant.Icon}
              icon={faThumbtack}
              aria-label={pinLabel}
              aria-pressed={task.pinned}
              title={pinLabel}
              onClick={() => void run(updateTask(task.id, { pinned: !task.pinned }))}
            />
          </div>
          <div className={styles.meta}>
            <Pill indicator={taskIndicator(task)} role="status">
              {pillLabel(task)}
            </Pill>
            <span className={styles.timing}>{timing(task, now)}</span>
          </div>
        </div>
        {!done && !isNewTask(task) && (
          <Button variant={ButtonVariant.Ghost} icon={faCheck} onClick={() => void run(markTaskDone(task.id))}>
            Mark done
          </Button>
        )}
      </div>
      <div className={styles.fields}>
        <FieldRow label="Objective" className={styles.objective}>
          {task.objective === '' ? <Empty>{EMPTY_OBJECTIVE}</Empty> : task.objective}
        </FieldRow>
        <FieldRow label={done ? 'Outcome' : 'Status'} className={styles.status}>
          {task.status === '' ? (
            <Empty>{EMPTY_STATUS}</Empty>
          ) : (
            <>
              {task.status}
              {!done && task.statusUpdatedAt !== null && (
                <span className={styles.updated}> · {formatAgo(task.statusUpdatedAt, now)}</span>
              )}
            </>
          )}
        </FieldRow>
      </div>
    </>
  )
}

/**
 * The selected task's header card: its title and pin toggle, status pill and timing, Mark done while it's active, and
 * its objective and status (its outcome once done). It follows the store, so it changes as the agent sets its fields.
 * Nothing shows while no task is selected.
 */
export function SelectedTaskHeader(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  if (task === undefined) return null
  return (
    <TaskHeader>
      <Header task={task} />
    </TaskHeader>
  )
}
