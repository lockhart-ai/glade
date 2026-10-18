import type { ReactNode } from 'react'
import { todoLinkId } from '../../shared/links'
import { useGladeStore } from '../store/react'
import styles from './Link.module.css'

export interface TodoLinkProps {
  /** The link's address, `todo:N` with the todo's id after `todo:` (`todoLinkId`). */
  readonly href: string
  readonly children: ReactNode
}

/**
 * A link to one of the task's todos, `[any text](todo:N)` in a reply (#684): clicking it (⌘-click too, or ↵ on it)
 * shows that todo in the Todos tab (`showTodo`), which opens the right panel there, expands the todo, scrolls it into
 * view and highlights it for a moment. A link to a todo the selected task doesn't have — none kept, one deleted, or
 * no task open — shows as its text, and everything that links to GitHub (`#123`, web links) stays as it is.
 */
export function TodoLink({ href, children }: TodoLinkProps): React.JSX.Element {
  const taskId = useGladeStore((state) => state.selectedTaskId)
  const todoId = todoLinkId(href)
  const showTodo = useGladeStore((state) => state.showTodo)
  const kept = useGladeStore((state) =>
    taskId === null || todoId === null
      ? false
      : (state.todos[taskId]?.items.some((todo) => todo.id === todoId) ?? false),
  )
  if (taskId === null || todoId === null || !kept) return <>{children}</>
  return (
    <a
      href={href}
      className={styles.link}
      onClick={(event) => {
        // The window never follows the link; the store shows the todo.
        event.preventDefault()
        event.stopPropagation()
        showTodo(taskId, todoId)
      }}
    >
      {children}
    </a>
  )
}
