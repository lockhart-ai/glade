import { faShield } from '@fortawesome/free-solid-svg-icons'
import { memo, useEffect, useRef, useState } from 'react'
import { TaskState, UNTITLED_TASK_TITLE, type EpochMs, type Task } from '../../shared/domain'
import type { TextPart } from '../../shared/search'
import { taskIndicator } from '../../shared/taskIndicator'
import { classNames } from '../components/classNames'
import type { ContextMenuTargetProps } from '../context-menus'
import { Dot, Icon, IconSize } from '../components'
import { Highlighted, Marked } from '../search/Highlight'
import { formatRelativeTime } from './relativeTime'
import { RowIndicators } from './RowIndicators'
import { rowStatus, sameRowStatus, type RowStatusSource } from './rowStatus'
import styles from './TaskRow.module.css'

/** What a task without a title yet is called. */
export const UNTITLED = UNTITLED_TASK_TITLE
export { NO_STATUS, WAITING_ON_YOU } from './rowStatus'

export interface TaskRowProps {
  task: Task
  /** The current time, for the relative time. */
  now: EpochMs
  selected: boolean
  onSelect: (taskId: string) => void
  /** A search result's: what to mark in the title (from `highlightPattern`). */
  highlight?: RegExp | null
  /** A search result's: the snippet shown, wrapped, instead of the status line. */
  snippet?: readonly TextPart[] | null
  /** Whether the title is being renamed (F2): the row shows a text field in its place. */
  renaming?: boolean
  /** Saves the new title; resolves false when it's refused (blank), and the field stays. */
  onRename?: (taskId: string, title: string) => Promise<boolean>
  /** Stops renaming, keeping the title. */
  onCancelRename?: () => void
  /** What opens the task's context menu from the row: a right-click, or ⇧F10 while it has the focus. */
  menuTarget?: ContextMenuTargetProps
  /**
   * How many live watchers its agent has (the Agents tab): the row shows an eye and the count on its indicators line,
   * done or not, so a task waiting on you that's still watching something shows it. None by default.
   */
  watching?: number
  /** How many of its agent's subagents are running (the Agents tab), shown on its indicators line. None by default. */
  subagents?: number
}

interface RenameFieldProps {
  task: Task
  onRename: (taskId: string, title: string) => Promise<boolean>
  onCancel: () => void
}

/**
 * The title's text field while renaming, holding the title selected. ↵ saves it, Esc cancels; a blank title is refused,
 * and the field stays until you type one or cancel. Leaving the field saves it too, unless it's blank: then it cancels.
 */
function RenameField({ task, onRename, onCancel }: RenameFieldProps): React.JSX.Element {
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  // In a microtask, since Rename can open this from the row's context menu, which returns the focus to where it was
  // (the task's input, #415) in one as it closes: the field must take it after that.
  useEffect(() => {
    queueMicrotask(() => {
      input.current?.focus()
      input.current?.select()
    })
  }, [])

  const save = async (title: string): Promise<void> => {
    // Saving unmounts the field, which can blur it on the way out: that mustn't save again.
    finished.current = true
    if (await onRename(task.id, title)) return
    finished.current = false
    setInvalid(true)
  }
  const cancel = (): void => {
    finished.current = true
    onCancel()
  }

  return (
    <input
      ref={input}
      className={styles.rename}
      aria-label="Task title"
      aria-invalid={invalid}
      defaultValue={task.title}
      placeholder={UNTITLED}
      onChange={() => {
        setInvalid(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void save(event.currentTarget.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
      }}
      onBlur={(event) => {
        if (finished.current) return
        if (event.currentTarget.value.trim() === '') cancel()
        else void save(event.currentTarget.value)
      }}
    />
  )
}

/** What a screen reader calls the shield on a row that waits on a permission. */
export const PERMISSION_SHIELD_LABEL = 'Permission'

/**
 * The row's line of status (`./rowStatus`), led by the shield while the task waits on a permission card: filled and
 * purple, as on the card it stands for (`docs/design/README.md`). It renders again only when the line itself changed,
 * whatever else of the task did, or however the clock ticked.
 */
const StatusLine = memo(function StatusLine(source: RowStatusSource): React.JSX.Element {
  const { text, permission } = rowStatus(source)
  return (
    <span className={styles.status}>
      {permission && (
        <span role="img" aria-label={PERMISSION_SHIELD_LABEL} className={styles.shield}>
          <Icon icon={faShield} size={IconSize.Small} />
        </span>
      )}
      {text}
    </span>
  )
}, sameRowStatus)

/**
 * One task in the list: its state dot, title and relative time, then one line of status ("Error: API overloaded ·
 * retry?" while an error has stopped its agent, "Paused: usage limit · resumes 11:42" while it's paused), each the
 * row's full width. Unread rows are bold. Under them, while there's any, a third line of what's going on in the task
 * (`RowIndicators`): its todo progress, running subagents and live watchers. As a search result, its title has the
 * matches marked, and a snippet around a match can take the status line's place.
 */
export function TaskRow({
  task,
  now,
  selected,
  onSelect,
  highlight = null,
  snippet = null,
  renaming = false,
  onRename,
  onCancelRename,
  menuTarget,
  watching = 0,
  subagents = 0,
}: TaskRowProps): React.JSX.Element {
  const indicators = <RowIndicators todos={task.todos} subagents={subagents} watching={watching} />
  const time = (
    <span className={styles.time}>
      {formatRelativeTime(task.updatedAt, now)}
      {task.unread && <span className={styles.unreadDot} role="img" aria-label="Unread" />}
    </span>
  )
  const className = classNames(
    styles.row,
    selected && styles.selected,
    task.unread && styles.unread,
    task.state === TaskState.Done && styles.done,
    snippet !== null && styles.result,
  )
  if (renaming && onRename !== undefined && onCancelRename !== undefined) {
    return (
      <div className={className} aria-current={selected ? 'true' : undefined}>
        <span className={styles.line}>
          <Dot state={taskIndicator(task)} />
          <RenameField task={task} onRename={onRename} onCancel={onCancelRename} />
          {time}
        </span>
        <StatusLine task={task} now={now} />
        {indicators}
      </div>
    )
  }
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      className={className}
      onClick={() => {
        onSelect(task.id)
      }}
      {...menuTarget}
    >
      <span className={styles.line}>
        <Dot state={taskIndicator(task)} />
        <span className={styles.title}>
          <Highlighted text={task.title === '' ? UNTITLED : task.title} pattern={highlight} />
        </span>
        {time}
      </span>
      {snippet === null ? (
        <StatusLine task={task} now={now} />
      ) : (
        <span className={styles.snippet}>
          <Marked parts={snippet} />
        </span>
      )}
      {indicators}
    </button>
  )
}
