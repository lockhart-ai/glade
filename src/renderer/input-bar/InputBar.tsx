import { faSquare } from '@fortawesome/free-regular-svg-icons'
import { faArrowUp } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { BridgeErrorCode, isBridgeError } from '../../shared/bridge'
import { Effort, TaskActivity, TaskState, type QueuedMessage, type Task } from '../../shared/domain'
import { MODEL_OPTIONS, modelName } from '../../shared/models'
import { Icon, IconSize, Textarea, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { selectSelectedTask } from '../store/state'
import { useGladeStore } from '../store/react'
import { QueueList } from './QueueList'
import { SettingPicker, type SettingOption } from './SettingPicker'
import styles from './InputBar.module.css'

/** What the effort picker calls each level. */
const EFFORT_NAMES: Readonly<Record<Effort, string>> = {
  [Effort.Low]: 'Low',
  [Effort.Medium]: 'Medium',
  [Effort.High]: 'High',
  [Effort.Max]: 'Max',
}

/** The effort picker's options, lowest first. */
const EFFORT_OPTIONS: readonly SettingOption[] = Object.values(Effort).map((effort) => ({
  id: effort,
  name: EFFORT_NAMES[effort],
}))

/** Permissions are fixed for now: the one option is Allow all (`docs/decisions.md`). */
const ALLOW_ALL = 'allow_all'
const PERMISSION_OPTIONS: readonly SettingOption[] = [{ id: ALLOW_ALL, name: 'Allow all' }]

export const NEW_TASK_PLACEHOLDER = 'Describe the task…'
export const REPLY_PLACEHOLDER = 'Reply…'
export const DONE_PLACEHOLDER = 'Send a message to reopen this task…'
export const QUEUE_PLACEHOLDER = 'Add a message. It will be queued until the agent finishes its current step.'

/** A task's queue when it has none. */
const NO_QUEUE: readonly QueuedMessage[] = []

function isEffort(value: string): value is Effort {
  return Object.values<string>(Effort).includes(value)
}

/**
 * What the empty field says: a new task asks for its description, a working agent's says the message will be queued,
 * and a done task's says a message reopens it.
 */
function placeholder(task: Task, started: boolean, working: boolean): string {
  if (task.state === TaskState.Done) return DONE_PLACEHOLDER
  if (working) return QUEUE_PLACEHOLDER
  return started ? REPLY_PLACEHOLDER : NEW_TASK_PLACEHOLDER
}

/** Whether main refused a command because the agent is working on a turn. */
function isBusy(error: unknown): boolean {
  return isBridgeError(error) && error.code === BridgeErrorCode.Busy
}

/** What the toast says when a message couldn't be sent. */
export function sendFailureMessage(error: unknown): string {
  return `Couldn’t send your message: ${describeFailure(error)}`
}

/** What the toast says when a queued message couldn't be edited or removed: most likely, it has just been sent. */
export function queueFailureMessage(action: string, error: unknown): string {
  if (isBridgeError(error) && error.code === BridgeErrorCode.NotFound) {
    return `Couldn’t ${action} the message: the agent already has it.`
  }
  return `Couldn’t ${action} the message: ${describeFailure(error)}`
}

/** Whether a key was pressed with a modifier, which leaves it to the field (⇧↑ selects, ⌘↑ goes to the start). */
function hasModifier(event: KeyboardEvent): boolean {
  return event.shiftKey || event.metaKey || event.altKey || event.ctrlKey
}

/** ⌘L, which focuses the input from anywhere in the window. */
function isFocusShortcut(event: globalThis.KeyboardEvent): boolean {
  return event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'l'
}

export interface InputBarProps {
  /** The context meter (P1-14), at the right of the settings row. Empty until then. */
  readonly contextMeter?: ReactNode
}

/** The selected task's input bar, or nothing when no task is selected. */
export function InputBar({ contextMeter }: InputBarProps): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  const focusInput = useGladeStore((state) => state.focusInput)
  const focusRequest = useGladeStore((state) => state.inputFocusRequest)
  // The last focus request the field has answered. It lives here, not in the task's bar, so a request made as a new
  // task's bar mounts (+ and ⌘N select the task, then ask) is still answered once.
  const answeredRef = useRef(focusRequest)

  // ⌘L asks for the focus the same way + and ⌘N do.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!isFocusShortcut(event)) return
      event.preventDefault()
      focusInput()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [focusInput])

  if (task === undefined) return null
  // A fresh draft for each task.
  return (
    <TaskInputBar
      key={task.id}
      task={task}
      contextMeter={contextMeter}
      focusRequest={focusRequest}
      answeredRef={answeredRef}
    />
  )
}

interface TaskInputBarProps extends InputBarProps {
  readonly task: Task
  /** The latest request for the field to take the focus (`inputFocusRequest`). */
  readonly focusRequest: number
  /** The last request answered; the bar focuses its field when `focusRequest` moves past it. */
  readonly answeredRef: RefObject<number>
}

/**
 * Where you talk to the task's agent: the model, effort and permissions settings above a message field. ↵ sends and
 * ⇧↵ adds a line. While the agent works, sending queues the message instead and Stop shows beside Send. The queue
 * shows above the settings, where each message can be edited in place or removed; ↑ in the empty field edits the last.
 */
function TaskInputBar({ task, contextMeter, focusRequest, answeredRef }: TaskInputBarProps): React.JSX.Element {
  const updateTask = useGladeStore((state) => state.updateTask)
  const sendMessage = useGladeStore((state) => state.sendMessage)
  const queueMessage = useGladeStore((state) => state.queueMessage)
  const editQueuedMessage = useGladeStore((state) => state.editQueuedMessage)
  const removeQueuedMessage = useGladeStore((state) => state.removeQueuedMessage)
  const queue = useGladeStore((state) => state.queuedMessages[task.id] ?? NO_QUEUE)
  const stopTask = useGladeStore((state) => state.stopTask)
  const started = useGladeStore((state) => (state.messages[task.id]?.length ?? 0) > 0)
  const toast = useToast()
  const field = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const working = task.state === TaskState.Active && task.activity === TaskActivity.Working
  // An empty draft doesn't disable Send (the design shows it ready); sending one just does nothing.
  const canSend = !sending
  // The message being edited has left the queue: delivered, or removed elsewhere.
  if (editingId !== null && !queue.some(({ id }) => id === editingId)) setEditingId(null)

  useEffect(() => {
    if (focusRequest === answeredRef.current) return
    answeredRef.current = focusRequest
    field.current?.focus()
  }, [focusRequest, answeredRef])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!canSend || text === '') return
    setSending(true)
    try {
      if (working) await queueMessage(task.id, text)
      else {
        // The agent may have started working since the bar last heard: then the message waits in the queue.
        await sendMessage(task.id, text).catch((error: unknown) => {
          if (!isBusy(error)) throw error
          return queueMessage(task.id, text)
        })
      }
      setDraft('')
    } catch (error) {
      toast.show({ message: sendFailureMessage(error) })
    } finally {
      setSending(false)
    }
  }

  const saveQueued = (id: string, text: string): void => {
    setEditingId(null)
    field.current?.focus()
    editQueuedMessage(id, text).catch((error: unknown) => {
      toast.show({ message: queueFailureMessage('edit', error) })
    })
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    field.current?.focus()
  }

  const removeQueued = (id: string): void => {
    removeQueuedMessage(id).catch((error: unknown) => {
      toast.show({ message: queueFailureMessage('remove', error) })
    })
  }

  const change = async (setting: string, patch: Parameters<typeof updateTask>[1]): Promise<void> => {
    try {
      await updateTask(task.id, patch)
    } catch (error) {
      toast.show({ message: `Couldn’t change the ${setting}: ${describeFailure(error)}` })
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const last = queue.at(-1)
    if (event.key === 'ArrowUp' && draft === '' && last !== undefined && !hasModifier(event)) {
      event.preventDefault()
      setEditingId(last.id)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <div className={styles.bar}>
      <QueueList
        messages={queue}
        working={working}
        editingId={editingId}
        onEdit={setEditingId}
        onSave={saveQueued}
        onCancel={cancelEdit}
        onRemove={removeQueued}
      />
      <div className={styles.settings}>
        <SettingPicker
          label="Model"
          value={modelName(task.model)}
          options={MODEL_OPTIONS}
          selectedId={task.model}
          onChoose={(model) => {
            if (model !== task.model) void change('model', { model })
          }}
        />
        <SettingPicker
          label="Effort"
          value={EFFORT_NAMES[task.effort]}
          options={EFFORT_OPTIONS}
          selectedId={task.effort}
          onChoose={(effort) => {
            if (isEffort(effort) && effort !== task.effort) void change('effort', { effort })
          }}
        />
        <SettingPicker
          label="Permissions"
          value="Allow all"
          options={PERMISSION_OPTIONS}
          selectedId={ALLOW_ALL}
          onChoose={() => undefined}
        />
        <div className={styles.meter} data-testid="context-meter-slot">
          {contextMeter}
        </div>
      </div>
      <div className={styles.compose}>
        <Textarea
          ref={field}
          label="Message the agent"
          placeholder={placeholder(task, started, working)}
          className={styles.field}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={onKeyDown}
        />
        {working && (
          <button
            type="button"
            className={styles.stop}
            onClick={() => {
              stopTask(task.id).catch((error: unknown) => {
                toast.show({ message: `Couldn’t stop the agent: ${describeFailure(error)}` })
              })
            }}
          >
            <Icon icon={faSquare} size={IconSize.Medium} />
            Stop
          </button>
        )}
        <button
          type="button"
          aria-label={working ? 'Queue message' : 'Send'}
          className={styles.send}
          disabled={!canSend}
          onClick={() => {
            void send()
          }}
        >
          <Icon icon={faArrowUp} size={IconSize.Large} />
        </button>
      </div>
    </div>
  )
}
