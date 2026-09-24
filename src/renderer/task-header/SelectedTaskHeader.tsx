import { faCheck, faThumbtack } from '@fortawesome/free-solid-svg-icons'
import { useMemo, type ReactNode } from 'react'
import { TaskState, type Task, type ToolEvent } from '../../shared/domain'
import { taskIndicator } from '../../shared/taskIndicator'
import { Button, ButtonVariant, Pill, useToast } from '../components'
import { TaskHeader } from '../layout'
import { Panel, PanelToggle, usePanel } from '../panels'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import { useNow } from '../task-list/useNow'
import {
  canMarkDone,
  EMPTY_OBJECTIVE,
  EMPTY_STATUS,
  EMPTY_TITLE,
  formatAgo,
  offersMarkDone,
  pillLabel,
  reopening,
  timing,
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
  readonly children: ReactNode
}

/** One labelled row under the divider: Objective, then Status (Outcome once the task is done). */
function FieldRow({ label, className, text, children }: FieldRowProps): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className={styles.row}>
      <div className={styles.label} aria-hidden>
        {label}
      </div>
      <p className={className} title={text === '' ? undefined : text}>
        {children}
      </p>
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
  const timingText = timing(task, now, reopened)
  const pinLabel = task.pinned ? 'Unpin task' : 'Pin task'

  return (
    <>
      <div className={styles.top}>
        {sidebarCollapsed && <PanelToggle panel={Panel.Sidebar} />}
        <div className={styles.heading}>
          <div className={styles.titleRow}>
            <h1 className={styles.title} title={task.title === '' ? undefined : task.title}>
              {task.title === '' ? <Empty>{EMPTY_TITLE}</Empty> : <Highlighted text={task.title} pattern={highlight} />}
            </h1>
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
              {pillLabel(task, reopened)}
            </Pill>
            <span className={styles.timing} title={timingText}>
              {timingText}
            </span>
          </div>
        </div>
        {offersMarkDone(task) && (
          <Button
            variant={ButtonVariant.Ghost}
            icon={faCheck}
            disabled={!canMarkDone(task)}
            onClick={() => void markDone(task.id)}
          >
            Mark done
          </Button>
        )}
        {panelCollapsed && <PanelToggle panel={Panel.RightPanel} />}
      </div>
      <div className={styles.fields}>
        <FieldRow label="Objective" className={styles.objective} text={task.objective}>
          {task.objective === '' ? (
            <Empty>{EMPTY_OBJECTIVE}</Empty>
          ) : (
            <Highlighted text={task.objective} pattern={highlight} />
          )}
        </FieldRow>
        <FieldRow label={done ? 'Outcome' : 'Status'} className={styles.status} text={task.status}>
          {task.status === '' ? (
            <Empty>{EMPTY_STATUS}</Empty>
          ) : (
            <>
              <Highlighted text={task.status} pattern={highlight} />
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
 * The selected task's header card: its title and pin toggle, status pill and timing, Mark done while it's active (disabled while the agent works), and
 * its objective and status (its outcome once done). While the right panel is collapsed, a button at the end of the top
 * row shows it again; while the task list is collapsed, one at the start shows that. It follows the store, so it changes as the agent sets its fields.
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
