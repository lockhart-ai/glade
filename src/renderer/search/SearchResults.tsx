import { useMemo } from 'react'
import type { Task } from '../../shared/domain'
import { SearchField, type SearchResult } from '../../shared/search'
import { useGladeStore } from '../store/react'
import { ContextMenu, useContextMenu } from '../context-menus'
import { TaskRow } from '../task-list/TaskRow'
import { useRenameTask } from '../task-list/useRenameTask'
import { useTaskMenu } from '../task-list/useTaskMenu'
import { useNow } from '../task-list/useNow'
import { useSearchHighlight } from './Highlight'
import styles from './SearchResults.module.css'
import { useSearchResults } from './useSearchResults'

export interface SearchResultsProps {
  /** The workspace searched. */
  workspaceId: string
}

/** What the sidebar says it searches, under the results. */
export const SEARCH_NOTE = 'Searches titles, objectives, outcomes and full chat logs.'

interface Shown {
  readonly task: Task
  readonly result: SearchResult
}

/**
 * The sidebar's search results, in place of the task list while the search field has text: a count, then a row per
 * matching task, best first, with its title's matches marked and a snippet around its best match (its status line
 * when only the title matches). The rows follow the store, so a task's dot and time stay live. Clicking one selects
 * its task, whose header and chat then show the matches, the chat scrolled to the first. Each row has the task's
 * context menu, as in the task list.
 */
export function SearchResults({ workspaceId }: SearchResultsProps): React.JSX.Element {
  const text = useGladeStore((state) => state.searchText)
  const tasks = useGladeStore((state) => state.tasks)
  const selectedTaskId = useGladeStore((state) => state.selectedTaskId)
  const openSearchResult = useGladeStore((state) => state.openSearchResult)
  const { renamingTaskId, rename, cancelRename } = useRenameTask()
  const menu = useContextMenu<string>()
  const taskMenu = useTaskMenu()
  const results = useSearchResults(workspaceId, text)
  const highlight = useSearchHighlight()
  const now = useNow()

  const shown = useMemo(
    () =>
      (results ?? []).flatMap((result): Shown[] => {
        const task = tasks[result.taskId]
        return task === undefined ? [] : [{ task, result }]
      }),
    [results, tasks],
  )

  const select = (taskId: string): void => {
    void openSearchResult(taskId)
  }

  return (
    <section className={styles.results} aria-label="Search results">
      <h2 className={styles.header}>
        <span>Results</span>
        <span>{results === null ? '' : shown.length}</span>
      </h2>
      <ul className={styles.rows}>
        {shown.map(({ task, result }) => (
          <li key={task.id}>
            <TaskRow
              task={task}
              now={now}
              selected={task.id === selectedTaskId}
              onSelect={select}
              highlight={highlight}
              snippet={result.field === SearchField.Title ? null : result.snippet}
              renaming={task.id === renamingTaskId}
              onRename={rename}
              onCancelRename={cancelRename}
              menuTarget={menu.targetProps(task.id)}
            />
          </li>
        ))}
      </ul>
      <p className={styles.note}>{SEARCH_NOTE}</p>
      <ContextMenu label="Task actions" state={menu} entries={taskMenu} />
    </section>
  )
}
