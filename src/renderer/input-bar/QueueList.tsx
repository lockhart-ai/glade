import { faCheck, faPen, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { QueuedMessage } from '../../shared/domain'
import { Button, ButtonVariant, Textarea } from '../components'
import { ContextMenu, queuedMessageMenu, useContextMenu, type ContextMenuTargetProps } from '../context-menus'
import styles from './QueueList.module.css'

/** What the queue's header says about when its messages go: after the agent's step, or with your next message. */
export const WORKING_HINT = 'Sent when the agent finishes its current step'
export const IDLE_HINT = 'Sent with your next message'
export const PAUSED_HINT = 'Sent when the task resumes'

export interface QueueListProps {
  readonly messages: readonly QueuedMessage[]
  /** Whether the agent is working, so the queue goes after its current step rather than with your next message. */
  readonly working: boolean
  /** Whether the task's turn is paused, so the queue goes once it resumes. */
  readonly paused?: boolean
  /** The message being edited in place, if any. */
  readonly editingId: string | null
  readonly onEdit: (id: string) => void
  /** Saves an edit; a blank one is dropped, keeping the message as it was. */
  readonly onSave: (id: string, text: string) => void
  readonly onCancel: () => void
  readonly onRemove: (id: string) => void
}

/**
 * The messages waiting for the agent, above the input (`docs/design/html/02-agent-working.html`): numbered in the order
 * they'll be delivered, each with Edit, which edits its text in place, and Remove, which its context menu has too.
 * Nothing when the queue is empty.
 */
export function QueueList({ messages, working, paused = false, ...row }: QueueListProps): React.JSX.Element | null {
  const menu = useContextMenu<string>()
  if (messages.length === 0) return null
  const entries = (id: string) =>
    queuedMessageMenu({
      edit: () => {
        row.onEdit(id)
      },
      remove: () => {
        row.onRemove(id)
      },
    })
  return (
    <section className={styles.queue} aria-label="Queued messages">
      <div className={styles.header}>
        <span className={styles.label}>Queued · {messages.length}</span>
        <span className={styles.hint}>{paused ? PAUSED_HINT : working ? WORKING_HINT : IDLE_HINT}</span>
      </div>
      <ol className={styles.list}>
        {messages.map((message, index) => (
          <QueueRow
            key={message.id}
            message={message}
            position={index + 1}
            menuTarget={menu.targetProps(message.id)}
            {...row}
          />
        ))}
      </ol>
      <ContextMenu label="Queued message actions" state={menu} entries={entries} />
    </section>
  )
}

interface QueueRowProps extends Omit<QueueListProps, 'messages' | 'working' | 'paused'> {
  readonly message: QueuedMessage
  /** Its place in the queue, from 1. */
  readonly position: number
  /** What opens its context menu, except while it's being edited. */
  readonly menuTarget: ContextMenuTargetProps
}

function QueueRow({ message, position, menuTarget, editingId, onEdit, onSave, onCancel, onRemove }: QueueRowProps) {
  const editing = editingId === message.id
  return (
    <li className={styles.row} {...(editing ? {} : menuTarget)}>
      <span className={styles.position}>{position}</span>
      {editing ? (
        <QueueEditor message={message} onSave={onSave} onCancel={onCancel} />
      ) : (
        <span className={styles.body} title={message.body}>
          {message.body}
        </span>
      )}
      {!editing && (
        <Button
          variant={ButtonVariant.Icon}
          icon={faPen}
          aria-label="Edit queued message"
          title="Edit queued message"
          onClick={() => {
            onEdit(message.id)
          }}
        />
      )}
      <Button
        variant={ButtonVariant.Icon}
        icon={faXmark}
        aria-label="Remove queued message"
        title="Remove queued message"
        onClick={() => {
          onRemove(message.id)
        }}
      />
    </li>
  )
}

interface QueueEditorProps {
  readonly message: QueuedMessage
  readonly onSave: (id: string, text: string) => void
  readonly onCancel: () => void
}

/** The message's text, editable in place: ↵ or leaving the field saves, ⇧↵ adds a line, Esc cancels. */
function QueueEditor({ message, onSave, onCancel }: QueueEditorProps): React.JSX.Element {
  const [text, setText] = useState(message.body)
  const field = useRef<HTMLTextAreaElement>(null)
  // Set once the edit is saved or cancelled, so the blur that follows doesn't save it again.
  const done = useRef(false)

  useEffect(() => {
    const element = field.current
    element?.focus()
    element?.setSelectionRange(element.value.length, element.value.length)
  }, [])

  const save = (): void => {
    if (done.current) return
    done.current = true
    if (text.trim() === '' || text.trim() === message.body) onCancel()
    else onSave(message.id, text.trim())
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      done.current = true
      onCancel()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    save()
  }

  return (
    <>
      <Textarea
        ref={field}
        label="Queued message"
        rows={1}
        className={styles.editor}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
        }}
        onKeyDown={onKeyDown}
        onBlur={save}
      />
      <Button
        variant={ButtonVariant.Icon}
        icon={faCheck}
        aria-label="Save queued message"
        title="Save queued message"
        // Keeps the field's focus, so its blur doesn't save before the click does.
        onMouseDown={(event) => {
          event.preventDefault()
        }}
        onClick={save}
      />
    </>
  )
}
