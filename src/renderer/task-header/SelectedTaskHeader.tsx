import { faCircleCheck, faThumbtack } from '@fortawesome/free-solid-svg-icons'
import { useMemo, type ReactNode } from 'react'
import { TaskState, type Task, type ToolEvent } from '../../shared/domain'
import { taskIndicator } from '../../shared/taskIndicator'
import { Button, ButtonVariant, Dot, useToast } from '../components'
import { classNames } from '../components/classNames'
import { TaskHeader } from '../layout'
import { Panel, PanelToggle, usePanel } from '../panels'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import { useNow } from '../task-list/useNow'
import {
  age,
  ageTitle,
  canMarkDone,
  EMPTY_OBJECTIVE,
  EMPTY_STATUS,
  EMPTY_TITLE,
  formatAge,
  offersMarkDone,
  reopening,
  stateLabel,
} from './headerModel'
import styles from './SelectedTaskHeader.module.css'
import { useMarkDone } from './useMarkDone'
import { Highlighted, useSearchHighlight } from '../search/Highlight'

const NO_TOOL_EVENTS: readonly ToolEvent[] = []

interface FieldRowProps {
  readonly label: string
  readonly className: string | undefined
  /** The row's full text, shown as its tooltip since the row clamps to a line or two. */
  readonly text: string
  /** Right-aligned at the end of the row: how long ago the agent set the status. */
  readonly trailing?: ReactNode
  readonly children: ReactNode
}

/** One labelled row under the title: Goal, then Now (Outcome once the task is done). */
function FieldRow({ label, className, text, trailing, children }: FieldRowProps): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className={styles.row}>
      <div className={styles.label} aria-hidden>
        {label}
      </div>
      <p className={className} title={text === '' ? undefined : text}>
        {children}
      </p>
      {trailing}
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
  const highlight = useSearchHighlight()
  const updateTask = useGladeStore((state) => state.updateTask)
  const markDone = useMarkDone()
  const toast = useToast()
  const done = task.state === TaskState.Done
  const toolEvents = useGladeStore((state) => state.toolEvents[task.id]) ?? NO_TOOL_EVENTS
  const reopened = useMemo(() => reopening(toolEvents), [toolEvents])
  const { collapsed: panelCollapsed } = usePanel(Panel.RightPanel)
  const { collapsed: sidebarCollapsed } = usePanel(Panel.Sidebar)

  const run = async (action: Promise<void>): Promise<void> => {
    try {
      await action
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
  }
  const label = stateLabel(task, reopened)
  const pinLabel = task.pinned ? 'Unpin task' : 'Pin task'
  const statusAge =
    !done && task.status !== '' && task.statusUpdatedAt !== null ? formatAge(task.statusUpdatedAt, now) : null

  return (
    <>
      <div className={styles.top}>
        {sidebarCollapsed && <PanelToggle panel={Panel.Sidebar} />}
        <div className={styles.heading}>
          {/* The same dot, in the same colours, as the task's row in the sidebar. */}
          <Dot state={taskIndicator(task)} label={label} title={label} className={styles.dot} />
          <h1 className={styles.title} title={task.title === '' ? undefined : task.title}>
            {task.title === '' ? <Empty>{EMPTY_TITLE}</Empty> : <Highlighted text={task.title} pattern={highlight} />}
          </h1>
          <span className={styles.age} title={ageTitle(task, reopened)}>
            · {age(task, now)}
          </span>
        </div>
        <Button
          variant={ButtonVariant.Icon}
          icon={faThumbtack}
          aria-label={pinLabel}
          aria-pressed={task.pinned}
          title={pinLabel}
          onClick={() => void run(updateTask(task.id, { pinned: !task.pinned }))}
        />
        {/* Mark done matches the pin: the same icon button, and a solid icon like the pin's (#289). */}
        {offersMarkDone(task) && (
          <Button
            variant={ButtonVariant.Icon}
            icon={faCircleCheck}
            aria-label="Mark done"
            title="Mark done"
            disabled={!canMarkDone(task)}
            onClick={() => void markDone(task.id)}
          />
        )}
        {panelCollapsed && <PanelToggle panel={Panel.RightPanel} />}
      </div>
      <div className={classNames(styles.fields, sidebarCollapsed && styles.afterToggle)}>
        <FieldRow label="Goal" className={styles.objective} text={task.objective}>
          {task.objective === '' ? (
            <Empty>{EMPTY_OBJECTIVE}</Empty>
          ) : (
            <Highlighted text={task.objective} pattern={highlight} />
          )}
        </FieldRow>
        <FieldRow
          label={done ? 'Outcome' : 'Now'}
          className={styles.status}
          text={task.status}
          trailing={statusAge !== null && <span className={styles.updated}>{statusAge}</span>}
        >
          {task.status === '' ? <Empty>{EMPTY_STATUS}</Empty> : <Highlighted text={task.status} pattern={highlight} />}
        </FieldRow>
      </div>
    </>
  )
}

/**
 * The selected task's header card. One line holds its state dot (the sidebar row's, named and titled by the state),
 * title and age, then its pin toggle and, while it's active, Mark done (disabled while the agent works). Below, lined up
 * with the title, are its goal and what it's doing now (its outcome once done). While the right panel is collapsed, a
 * button at the end of the top row shows it again; while the task list is collapsed, one at the start shows that. It
 * follows the store, so it changes as the agent sets its fields. Nothing shows while no task is selected.
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
