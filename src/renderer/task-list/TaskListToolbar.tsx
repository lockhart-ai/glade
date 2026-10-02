import { faMagnifyingGlass, faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useRef } from 'react'
import { Button, ButtonVariant, Input } from '../components'
import { useGladeStore } from '../store/react'
import { AppCommandId } from '../../shared/commands'
import { useBinding } from '../commands/hooks'
import { useNewTask } from './useNewTask'
import styles from './TaskListToolbar.module.css'

export interface TaskListToolbarProps {
  /** The workspace new tasks are created in. */
  workspaceId: string
}

/** Whether the search field's text makes a search, so the sidebar shows results in place of the task list. */
export function isSearching(text: string): boolean {
  return text.trim() !== ''
}

/**
 * Above the task list: the search field and the New task button. Typing in the search field searches the workspace,
 * and the sidebar shows the results in place of the list; Esc, or emptying the field, ends the search. ⌘F focuses the
 * field, selecting what's in it (`focusSearch`), showing the sidebar first if it's collapsed (`useSearchShortcut`).
 */
export function TaskListToolbar({ workspaceId }: TaskListToolbarProps): React.JSX.Element {
  const newTask = useNewTask(workspaceId)
  const newTaskKeys = useBinding(AppCommandId.NewTask)
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
    </div>
  )
}
