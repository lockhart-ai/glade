import { faChevronDown, faChevronRight, faThumbtack } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useId, useMemo } from 'react'
import { parseTaskFilter } from '../../shared/attention'
import { UiStateKey } from '../../shared/domain'
import { Icon, IconSize, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import {
  collapsedValue,
  collapseKey,
  isCollapsed,
  SectionId,
  sectionTasks,
  Step,
  stepSelection,
  visibleTaskIds,
  type TaskSection,
} from './sections'
import { TaskRow } from './TaskRow'
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

/** Whether keys typed into this element edit text, so ⌥↑ / ⌥↓ belong to it rather than the task list. */
function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  )
}

/** The step ⌥↑ or ⌥↓ asks for, or null for any other key. */
function stepFor(event: KeyboardEvent): Step | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null
  switch (event.key) {
    case 'ArrowUp':
      return Step.Previous
    case 'ArrowDown':
      return Step.Next
    default:
      return null
  }
}

/**
 * A workspace's tasks in the Pinned, Active and Done sections, kept live from the store, narrowed to the filter chosen
 * with the chips above (`TaskListToolbar`); each section counts the tasks it shows. Each section collapses, and
 * remembers it. Clicking a row selects its task; ⌥↑ / ⌥↓ move the selection through the expanded sections. The task
 * being renamed (F2) shows a text field for its title in its row.
 */
export function TaskList({ workspaceId }: TaskListProps): React.JSX.Element {
  const tasks = useGladeStore((state) => state.tasks)
  const uiState = useGladeStore((state) => state.uiState)
  const selectedTaskId = useGladeStore((state) => state.selectedTaskId)
  const selectTask = useGladeStore((state) => state.selectTask)
  const renamingTaskId = useGladeStore((state) => state.renamingTaskId)
  const renameTask = useGladeStore((state) => state.renameTask)
  const cancelRename = useGladeStore((state) => state.cancelRename)
  const toast = useToast()
  const setUiState = useGladeStore((state) => state.setUiState)
  const now = useNow()

  const filter = parseTaskFilter(uiState[UiStateKey.TaskFilter])
  const sections = useMemo(() => sectionTasks(Object.values(tasks), workspaceId, filter), [tasks, workspaceId, filter])
  const order = useMemo(() => visibleTaskIds(sections, uiState), [sections, uiState])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const step = stepFor(event)
      if (step === null || isTextField(event.target)) return
      event.preventDefault()
      const next = stepSelection(order, selectedTaskId, step)
      if (next !== null && next !== selectedTaskId) void selectTask(next)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [order, selectedTaskId, selectTask])

  const select = (taskId: string): void => {
    void selectTask(taskId)
  }
  const rename = async (taskId: string, title: string): Promise<boolean> => {
    try {
      return await renameTask(taskId, title)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
      cancelRename()
      return true
    }
  }

  return (
    <div className={styles.list}>
      {sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          collapsed={isCollapsed(uiState, section.id)}
          onToggle={(collapsed) => {
            void setUiState({ key: collapseKey(section.id), value: collapsedValue(collapsed) })
          }}
        >
          {section.tasks.map((task) => (
            <li key={task.id}>
              <TaskRow
                task={task}
                now={now}
                selected={task.id === selectedTaskId}
                onSelect={select}
                renaming={task.id === renamingTaskId}
                onRename={rename}
                onCancelRename={cancelRename}
              />
            </li>
          ))}
        </Section>
      ))}
    </div>
  )
}

interface SectionProps {
  section: TaskSection
  collapsed: boolean
  onToggle: (collapsed: boolean) => void
  children: React.ReactNode
}

/** A section header (chevron, name, count) that collapses the rows below it. */
function Section({ section, collapsed, onToggle, children }: SectionProps): React.JSX.Element {
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
        <span>{section.tasks.length}</span>
      </button>
      {!collapsed && (
        <ul id={listId} className={styles.rows}>
          {children}
        </ul>
      )}
    </section>
  )
}
