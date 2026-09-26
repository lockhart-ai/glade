import { faSquare } from '@fortawesome/free-regular-svg-icons'
import { faArrowUp } from '@fortawesome/free-solid-svg-icons'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { BridgeErrorCode, isBridgeError } from '../../shared/bridge'
import {
  Effort,
  PermissionMode,
  TaskActivity,
  TaskState,
  type InputDraft,
  type QueuedMessage,
  type Task,
} from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { EFFORT_NAMES, effortFallbackNotice, effortFor, effortsOf, findModel, modelName } from '../../shared/models'
import { isCommandKey, useCommand, useKeymap } from '../commands/hooks'
import { MESSAGE_FIELD_PROPS } from '../commands/registry'
import { Icon, IconSize, Textarea, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { selectSelectedTask } from '../store/state'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import { pastedFiles, readPastedFiles } from '../images/pasted'
import { PAUSED_PLACEHOLDER } from '../pause/pauseModel'
import { Attachments, type Attachment } from './Attachments'
import { QueueList } from './QueueList'
import { SettingPicker, type SettingOption } from './SettingPicker'
import styles from './InputBar.module.css'

/** What the permissions picker calls each mode (`docs/decisions.md`, "Per-call permission review"). */
export const PERMISSION_MODE_NAMES: Readonly<Record<PermissionMode, string>> = {
  [PermissionMode.AllowAll]: 'Allow all',
  [PermissionMode.AskBeforeEdits]: 'Ask before edits and commands',
}

/** The permissions picker's options: Allow all, then the ask mode. */
const PERMISSION_OPTIONS: readonly SettingOption[] = Object.values(PermissionMode).map((mode) => ({
  id: mode,
  name: PERMISSION_MODE_NAMES[mode],
}))

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

/**
 * How long the draft waits after the last change before it's stored in main: a pause in typing, so a burst of keys is
 * one save. Switching tasks, sending and quitting store it at once.
 */
export const DRAFT_SAVE_DELAY_MS = 400

/** The input bar's draft as it keeps it: the images as their attachments, whose array changes only when they do. */
interface BarDraft {
  readonly text: string
  readonly attachments: readonly Attachment[]
}

function sameDraft(a: BarDraft, b: BarDraft): boolean {
  return a.text === b.text && a.attachments === b.attachments
}

function toImages(attachments: readonly Attachment[]): InputDraft['images'] {
  return attachments.map(({ image }) => image)
}

/** A stored draft's images as attachments, numbered on from the bar's last. */
function toAttachments(draft: InputDraft, attached: RefObject<number>): readonly Attachment[] {
  if (draft.images.length === 0) return NO_ATTACHMENTS
  return draft.images.map((image) => {
    attached.current += 1
    return { key: attached.current, image }
  })
}

function isEffort(value: string): value is Effort {
  return Object.values<string>(Effort).includes(value)
}

function isPermissionMode(value: string): value is PermissionMode {
  return Object.values<string>(PermissionMode).includes(value)
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
  // Each task's own draft: the bar keeps it as it goes, and a task selected again gets it back.
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
  const models = useGladeStore((state) => state.models)
  const started = useGladeStore((state) => (state.messages[task.id]?.length ?? 0) > 0)
  const toast = useToast()
  const keymap = useKeymap()
  const field = useRef<HTMLTextAreaElement>(null)
  const keepInputDraft = useGladeStore((state) => state.keepInputDraft)
  const loadInputDraft = useGladeStore((state) => state.loadInputDraft)
  const saveInputDraft = useGladeStore((state) => state.saveInputDraft)
  // The draft kept for the task as its bar last went, if any: the bar starts from it. Read once, as the bar mounts.
  const storeApi = useGladeStoreApi()
  const [kept] = useState(() => storeApi.getState().inputDrafts[task.id])
  const [draft, setDraft] = useState(kept?.text ?? '')
  const [attachments, setAttachments] = useState<readonly Attachment[]>(
    () => kept?.images.map((image, index) => ({ key: index + 1, image })) ?? NO_ATTACHMENTS,
  )
  const [refusals, setRefusals] = useState(NO_REFUSALS)
  const attached = useRef(kept?.images.length ?? 0)
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

  // The draft as it now is, and as main last stored it (or had it, as the bar mounted): a change is stored a pause
  // after it's made, and at once when the bar goes (another task selected) or the window does (quitting).
  const latest = useRef<BarDraft>({ text: draft, attachments })
  const stored = useRef<BarDraft>({ text: draft, attachments })
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Stores the draft in main if it changed since it last was: its text, and its images only when they changed. */
  const saveNow = useCallback(() => {
    if (pendingSave.current !== null) clearTimeout(pendingSave.current)
    pendingSave.current = null
    const current = latest.current
    const last = stored.current
    if (sameDraft(current, last)) return
    stored.current = current
    const images = current.attachments === last.attachments ? {} : { images: toImages(current.attachments) }
    void saveInputDraft({ taskId: task.id, text: current.text, ...images })
  }, [saveInputDraft, task.id])

  useEffect(() => {
    latest.current = { text: draft, attachments }
    if (pendingSave.current !== null) clearTimeout(pendingSave.current)
    pendingSave.current = sameDraft(latest.current, stored.current) ? null : setTimeout(saveNow, DRAFT_SAVE_DELAY_MS)
  }, [draft, attachments, saveNow])

  useEffect(() => {
    const flush = saveNow
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
      const { text, attachments: going } = latest.current
      keepInputDraft(task.id, { text, images: toImages(going) })
    }
  }, [keepInputDraft, saveNow, task.id])

  // With none kept, the task may have one stored from before a relaunch or a crash: it goes in, unless you've started
  // on a new one since.
  useEffect(() => {
    if (kept !== undefined) return
    let mounted = true
    void loadInputDraft(task.id).then((loaded) => {
      const current = latest.current
      if (!mounted || loaded === null || current.text !== '' || current.attachments.length > 0) return
      const restored: BarDraft = { text: loaded.text, attachments: toAttachments(loaded, attached) }
      stored.current = restored
      latest.current = restored
      setDraft(restored.text)
      setAttachments(restored.attachments)
    })
    return () => {
      mounted = false
    }
  }, [kept, loadInputDraft, task.id])

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
      // Sent, so the task has no draft now: stored at once, over any save of it on its way, and kept, should the bar
      // have gone (another task selected) while it was sending.
      latest.current = { text: '', attachments: NO_ATTACHMENTS }
      saveNow()
      keepInputDraft(task.id, { text: '', images: [] })
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

  /** Changes the task's settings; answers whether they changed. */
  const change = async (setting: string, patch: Parameters<typeof updateTask>[1]): Promise<boolean> => {
    try {
      await updateTask(task.id, patch)
      return true
    } catch (error) {
      toast.show({ message: `Couldn’t change the ${setting}: ${describeFailure(error)}` })
      return false
    }
  }

  // The task's model as the list has it (a task saved with a full id is on the alias that stands for it), and the
  // effort levels it supports: none hides the effort picker.
  const selectedModel = findModel(models, task.model)?.id ?? task.model
  const efforts = effortsOf(models, task.model)

  /** Changes the model, and the effort with it when the new model doesn't support the task's, saying so. */
  const changeModel = async (model: string): Promise<void> => {
    const effort = effortFor(models, model, task.effort)
    if (!(await change('model', effort === task.effort ? { model } : { model, effort }))) return
    const notice = effortFallbackNotice(models, model, task.effort, effort)
    if (notice !== null) toast.show({ message: notice })
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
          value={modelName(models, task.model)}
          options={models}
          selectedId={selectedModel}
          onChoose={(model) => {
            if (model !== selectedModel) void changeModel(model)
          }}
        />
        {efforts.length > 0 && (
          <SettingPicker
            label="Effort"
            value={EFFORT_NAMES[task.effort]}
            options={efforts.map((effort) => ({ id: effort, name: EFFORT_NAMES[effort] }))}
            selectedId={task.effort}
            onChoose={(effort) => {
              if (isEffort(effort) && effort !== task.effort) void change('effort', { effort })
            }}
          />
        )}
        <SettingPicker
          label="Permissions"
          value={PERMISSION_MODE_NAMES[task.permissionMode]}
          options={PERMISSION_OPTIONS}
          selectedId={task.permissionMode}
          onChoose={(permissionMode) => {
            if (isPermissionMode(permissionMode) && permissionMode !== task.permissionMode) {
              void change('permissions', { permissionMode })
            }
          }}
        />
        <div className={styles.meter} data-testid="context-meter-slot">
          {contextMeter}
        </div>
      </div>
      <Attachments attachments={attachments} refusals={refusals} onRemove={removeAttachment} />
      <div className={styles.compose}>
        <Textarea
          {...MESSAGE_FIELD_PROPS}
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
