import { faSquare } from '@fortawesome/free-regular-svg-icons'
import { faArrowUp } from '@fortawesome/free-solid-svg-icons'
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { BridgeErrorCode, isBridgeError } from '../../shared/bridge'
import { Effort, TaskActivity, TaskState, type QueuedMessage, type Task } from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { EFFORT_NAMES, MODEL_OPTIONS, modelName } from '../../shared/models'
import { isCommandKey, useCommand, useKeymap } from '../commands/hooks'
import { Icon, IconSize, Textarea, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { selectSelectedTask } from '../store/state'
import { useGladeStore } from '../store/react'
import { pastedFiles, readPastedFiles } from '../images/pasted'
import { PAUSED_PLACEHOLDER } from '../pause/pauseModel'
import { Attachments, type Attachment } from './Attachments'
import { QueueList } from './QueueList'
import { SettingPicker, type SettingOption } from './SettingPicker'
import styles from './InputBar.module.css'

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
/** While the agent's questions are open: a message answers them in your own words (`03-rich-question.png`). */
export const ASKING_PLACEHOLDER = 'Or reply in your own words…'
export const DONE_PLACEHOLDER = 'Send a message to reopen this task…'
export const ERROR_PLACEHOLDER = 'Reply, or press Retry…'
export const QUEUE_PLACEHOLDER = 'Add a message. It will be queued until the agent finishes its current step.'
/** Why images can't go while the agent's questions are open: a reply then answers them, and an answer is words. */
export const ASKING_IMAGES_REFUSAL =
  'Images can’t go with an answer to the agent’s questions. Answer in words, then send the images after.'

/** A task's queue when it has none. */
const NO_QUEUE: readonly QueuedMessage[] = []
const NO_ATTACHMENTS: readonly Attachment[] = []
const NO_REFUSALS: readonly string[] = []

function isEffort(value: string): value is Effort {
  return Object.values<string>(Effort).includes(value)
}

/**
 * What the empty field says: a new task asks for its description, a working agent's says the message will be queued,
 * a paused one's that it's queued until the task resumes, one an error stopped points at the error card's Retry, and a
 * done task's says a message reopens it. While the agent's questions are open, it offers to answer them in words.
 */
function placeholder(task: Task, started: boolean, working: boolean): string {
  if (task.state === TaskState.Done) return DONE_PLACEHOLDER
  if (task.asking) return ASKING_PLACEHOLDER
  if (working) return QUEUE_PLACEHOLDER
  if (task.activity === TaskActivity.Paused) return PAUSED_PLACEHOLDER
  if (task.activity === TaskActivity.Error) return ERROR_PLACEHOLDER
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

/** The draft with text added to it (Quote in reply, Ask agent about this): after what's there, a blank line apart. */
export function withInsertion(draft: string, text: string): string {
  return draft.trim() === '' ? text : `${draft.trimEnd()}\n\n${text}`
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

  // Focus input (⌘L) asks for the focus the same way + and ⌘N do.
  useCommand(WindowCommandId.FocusInput, focusInput)

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
 * Where you talk to the task's agent: the model, effort and permissions settings above a message field. Send (↵) sends
 * and ⇧↵ adds a line. Pasting text inserts it at the caret, as plain text; pasting images attaches them to the message,
 * as thumbnails above the field, and they go with it, alone or with text. Anything else pasted is refused, saying why. While the agent works, sending queues the message instead and Stop shows beside Send; while its turn
 * is paused, sending queues it too, until the task resumes. The queue
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
  const keymap = useKeymap()
  const field = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState(NO_ATTACHMENTS)
  const [refusals, setRefusals] = useState(NO_REFUSALS)
  const attached = useRef(0)
  const [sending, setSending] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const insertion = useGladeStore((state) => state.inputInsertion)
  // The last request to add text that the draft has taken, so a request is only ever taken once.
  const [insertedRequest, setInsertedRequest] = useState(insertion?.request)
  // The request there was when the bar mounted, which it doesn't take.
  const [mountedRequest] = useState(insertion?.request)

  const working = task.state === TaskState.Active && task.activity === TaskActivity.Working
  // A paused turn resumes on its own: messages wait in the queue until then.
  const paused = task.state === TaskState.Active && task.activity === TaskActivity.Paused
  // An empty draft doesn't disable Send (the design shows it ready); sending one just does nothing.
  const canSend = !sending
  // The message being edited has left the queue: delivered, or removed elsewhere.
  if (editingId !== null && !queue.some(({ id }) => id === editingId)) setEditingId(null)

  // A new request to add text to this task's draft: add it while rendering, so it shows in the same commit.
  if (insertion !== null && insertion.taskId === task.id && insertion.request !== insertedRequest) {
    setInsertedRequest(insertion.request)
    setDraft((current) => withInsertion(current, insertion.text))
  }

  // Then focus the field, with the caret at the end, after what was added. In a microtask, since the request comes from
  // a menu, which returns the focus to where it was in one as it closes: the field must take it after that.
  useEffect(() => {
    if (insertedRequest === mountedRequest) return
    queueMicrotask(() => {
      const element = field.current
      element?.focus()
      element?.setSelectionRange(element.value.length, element.value.length)
    })
  }, [insertedRequest, mountedRequest])

  useEffect(() => {
    if (focusRequest === answeredRef.current) return
    answeredRef.current = focusRequest
    field.current?.focus()
  }, [focusRequest, answeredRef])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    const images = attachments.map(({ image }) => image)
    if (!canSend || (text === '' && images.length === 0)) return
    if (task.asking && images.length > 0) {
      setRefusals([ASKING_IMAGES_REFUSAL])
      return
    }
    setSending(true)
    try {
      // A message to an agent waiting on answers to its questions answers them, so it's sent, whatever else holds the task.
      if ((working || paused) && !task.asking) await queueMessage(task.id, text, images)
      else {
        // The agent may have started working since the bar last heard: then the message waits in the queue.
        await sendMessage(task.id, text, images).catch((error: unknown) => {
          if (!isBusy(error)) throw error
          return queueMessage(task.id, text, images)
        })
      }
      setDraft('')
      setAttachments(NO_ATTACHMENTS)
      setRefusals(NO_REFUSALS)
    } catch (error) {
      toast.show({ message: sendFailureMessage(error) })
    } finally {
      setSending(false)
    }
  }

  // A paste of text is left to the field, which inserts it at the caret as plain text. One of files attaches the images
  // among them, and says why it didn't attach the rest.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = pastedFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void readPastedFiles(files).then(({ images, refusals: refused }) => {
      const added = images.map((image) => {
        attached.current += 1
        return { key: attached.current, image }
      })
      setAttachments((current) => [...current, ...added])
      setRefusals(refused)
    })
  }

  const removeAttachment = (key: number): void => {
    setAttachments((current) => current.filter((attachment) => attachment.key !== key))
    setRefusals(NO_REFUSALS)
    field.current?.focus()
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
    if (draft === '' && last !== undefined && isCommandKey(WindowCommandId.EditLastQueued, keymap, event)) {
      event.preventDefault()
      setEditingId(last.id)
      return
    }
    if (!isCommandKey(WindowCommandId.Send, keymap, event) || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <div className={styles.bar}>
      <QueueList
        messages={queue}
        working={working}
        paused={paused}
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
      <Attachments attachments={attachments} refusals={refusals} onRemove={removeAttachment} />
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
          onPaste={onPaste}
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
          aria-label={working || paused ? 'Queue message' : 'Send'}
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
