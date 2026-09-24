import { faMagnifyingGlass, faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useMemo, useRef } from 'react'
import { needsYou, parseTaskFilter, TaskFilter } from '../../shared/attention'
import { UiStateKey, type Task } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Button, ButtonVariant, Input } from '../components'
import { useGladeStore } from '../store/react'
import { CommandId } from '../../shared/keymap'
import { useBinding } from '../commands/hooks'
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

/** Whether the search field's text makes a search, so the sidebar shows results in place of the task list. */
export function isSearching(text: string): boolean {
  return text.trim() !== ''
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
 * filter the task list and remember the choice. Typing in the search field searches the workspace, and the sidebar
 * shows the results in place of the list (and no chips); Esc, or emptying the field, ends the search. ⌘F focuses the
 * field, selecting what's in it (`focusSearch`), showing the sidebar first if it's collapsed (`useSearchShortcut`).
 */
export function TaskListToolbar({ workspaceId }: TaskListToolbarProps): React.JSX.Element {
  const tasks = useGladeStore((state) => state.tasks)
  const newTask = useNewTask(workspaceId)
  const newTaskKeys = useBinding(CommandId.NewTask)
  const counts = useMemo(() => countChips(Object.values(tasks), workspaceId), [tasks, workspaceId])
  const chosen = useGladeStore((state) => parseTaskFilter(state.uiState[UiStateKey.TaskFilter]))
  const setUiState = useGladeStore((state) => state.setUiState)
  const searchText = useGladeStore((state) => state.searchText)
  const setSearchText = useGladeStore((state) => state.setSearchText)
  const searchFocusRequest = useGladeStore((state) => state.searchFocusRequest)
  const searchField = useRef<HTMLInputElement>(null)
  // The request the field last answered, starting from the one there was when it mounted: a sidebar shown again after
  // being collapsed mounts a new field, which mustn't take the focus for an old ⌘F.
  const handledFocusRequest = useRef(searchFocusRequest)
  useEffect(() => {
    if (searchFocusRequest === handledFocusRequest.current) return
    handledFocusRequest.current = searchFocusRequest
    searchField.current?.focus()
    searchField.current?.select()
  }, [searchFocusRequest])
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
          ref={searchField}
          value={searchText}
          onChange={(event) => {
            setSearchText(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || searchText === '') return
            event.preventDefault()
            setSearchText('')
          }}
        />
        <Button
          variant={ButtonVariant.Dark}
          icon={faPlus}
          aria-label="New task"
          title={`New task (${newTaskKeys.label})`}
          className={styles.newTask}
          onClick={() => void newTask()}
        />
      </div>
      {!isSearching(searchText) && (
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
      )}
    </div>
  )
}
