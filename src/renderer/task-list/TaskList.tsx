import { faChevronDown, faChevronRight, faThumbtack } from '@fortawesome/free-solid-svg-icons'
import { useId, useMemo } from 'react'
import { parseTaskFilter, TaskFilter } from '../../shared/attention'
import { UiStateKey } from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { useCommands } from '../commands/hooks'
import { Collapse, Icon, IconSize } from '../components'
import { ContextMenu, useContextMenu } from '../context-menus'
import { useGladeStore } from '../store/react'
import {
  collapsedValue,
  collapseKey,
  isCollapsed,
  nextNeedingYou,
  SectionId,
  sectionTasks,
  Step,
  stepSelection,
  visibleTaskIds,
  type TaskSection,
} from './sections'
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

/**
 * A workspace's tasks in the Pinned, Active and Done sections, kept live from the store, narrowed to the filter chosen
 * with the chips above (`TaskListToolbar`); each section counts the tasks it shows. Each section collapses, and
 * remembers it. Clicking a row selects its task; ⌥↑ / ⌥↓ move the selection through the expanded sections, and ⌘⌥↓
 * jumps to the next task that needs you. The task
 * being renamed (F2) shows a text field for its title in its row. Right-clicking a row, or ⇧F10 on it, opens the task's
 * context menu.
 */
export function TaskList({ workspaceId }: TaskListProps): React.JSX.Element {
  const tasks = useGladeStore((state) => state.tasks)
  const uiState = useGladeStore((state) => state.uiState)
  const selectedTaskId = useGladeStore((state) => state.selectedTaskId)
  const selectTask = useGladeStore((state) => state.selectTask)
  const { renamingTaskId, rename, cancelRename } = useRenameTask()
  const setUiState = useGladeStore((state) => state.setUiState)
  const now = useNow()
  const menu = useContextMenu<string>()
  const taskMenu = useTaskMenu()

  const filter = parseTaskFilter(uiState[UiStateKey.TaskFilter])
  const sections = useMemo(() => sectionTasks(Object.values(tasks), workspaceId, filter), [tasks, workspaceId, filter])
  const order = useMemo(() => visibleTaskIds(sections, uiState), [sections, uiState])

  const step = (direction: Step): void => {
    const next = stepSelection(order, selectedTaskId, direction)
    if (next !== null && next !== selectedTaskId) void selectTask(next)
  }
  useCommands({
    [WindowCommandId.NextTask]: () => {
      step(Step.Next)
    },
    [WindowCommandId.PreviousTask]: () => {
      step(Step.Previous)
    },
    [WindowCommandId.NextTaskNeedingYou]: () => {
      const next = nextNeedingYou(sectionTasks(Object.values(tasks), workspaceId, TaskFilter.All), selectedTaskId)
      if (next !== null) void selectTask(next)
    },
  })

  const select = (taskId: string): void => {
    void selectTask(taskId)
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
                menuTarget={menu.targetProps(task.id)}
              />
            </li>
          ))}
        </Section>
      ))}
      <ContextMenu label="Task actions" state={menu} entries={taskMenu} />
    </div>
  )
}

interface SectionProps {
  section: TaskSection
  collapsed: boolean
  onToggle: (collapsed: boolean) => void
  children: React.ReactNode
}

/** A section header (chevron, name, count) that collapses the rows below it, which slide open and shut. */
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
      <Collapse open={!collapsed}>
        <ul id={listId} className={styles.rows}>
          {children}
        </ul>
      </Collapse>
    </section>
  )
}
