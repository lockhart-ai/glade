import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { faArrowUp } from '@fortawesome/free-solid-svg-icons'
import { memo, useCallback, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { TaskAttention, taskAttention } from '../../shared/attention'
import { BroadcastDelivery, type BroadcastFailed, type BroadcastOutcome } from '../../shared/broadcast'
import { WindowCommandId } from '../../shared/commands'
import { UNTITLED_TASK_TITLE } from '../../shared/domain'
import { TaskIndicator } from '../../shared/taskIndicator'
import { isCommandKey, useKeymap } from '../commands/hooks'
import { Button, ButtonVariant, Dot, Kbd, Textarea, useModalPresence, useOverlayRef, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import { badgeTone } from '../workspace-switcher/switcherModel'
import { BadgeSize, WorkspaceBadge } from '../workspace-switcher/WorkspaceBadge'
import {
  attentionLabel,
  broadcastFailureMessage,
  BUSY_NOTE,
  NO_RECIPIENTS,
  NOTHING_TICKED,
  reachText,
  recipientCount,
  recipientIds,
  recipientTaskIds,
  recipientWorkspaceIds,
  setTicked,
  tickedCounts,
  undeliveredMessage,
  WorkspaceTick,
  workspaceTick,
} from './broadcastModel'
import styles from './BroadcastDialog.module.css'

/** The dot each standing shows: the task list's colours, by the one attention rule. */
const ATTENTION_DOTS: Readonly<Record<TaskAttention, TaskIndicator>> = {
  [TaskAttention.NeedsYou]: TaskIndicator.Waiting,
  [TaskAttention.Working]: TaskIndicator.Working,
  [TaskAttention.Idle]: TaskIndicator.Idle,
}

/** A task's title as the task list shows it: what a task is called until its agent names it, for one without. */
function shownTitle(title: string | undefined): string {
  return title === undefined || title === '' ? UNTITLED_TASK_TITLE : title
}

/** The box a row starts with: a tick when its tasks are all ticked, a dash when only some are, empty when none is. */
function TickBox({ tick }: { tick: WorkspaceTick }): React.JSX.Element {
  return (
    <span aria-hidden className={styles.box} data-tick={tick}>
      <span className={styles.mark} />
    </span>
  )
}

interface RecipientRowProps {
  readonly taskId: string
  /** Whether the task is ticked to receive the broadcast. */
  readonly ticked: boolean
  /** Ticks the given tasks (or unticks them), as a row's box was asked. */
  readonly onTick: (taskIds: readonly string[], on: boolean) => void
}

/**
 * One task the broadcast reaches, as a tick box (#675): its box, its dot, its title and where it stands with you; the
 * whole row toggles it. It reads only its own title, standing and tick, so a change to one task renders its row and
 * no other.
 */
export const RecipientRow = memo(function RecipientRow({
  taskId,
  ticked,
  onTick,
}: RecipientRowProps): React.JSX.Element | null {
  const title = useGladeStore((state) => state.tasks[taskId]?.title)
  const attention = useGladeStore((state) => {
    const task = state.tasks[taskId]
    return task === undefined ? undefined : taskAttention(task)
  })
  if (title === undefined || attention === undefined) return null
  return (
    <li className={styles.task} data-attention={attention}>
      <button
        type="button"
        role="checkbox"
        aria-checked={ticked}
        aria-label={shownTitle(title)}
        className={styles.row}
        onClick={() => {
          onTick([taskId], !ticked)
        }}
      >
        <TickBox tick={ticked ? WorkspaceTick.All : WorkspaceTick.None} />
        <Dot state={ATTENTION_DOTS[attention]} />
        <span className={styles.taskTitle}>{shownTitle(title)}</span>
        <span className={styles.attention}>{attentionLabel(attention)}</span>
      </button>
    </li>
  )
})

interface RecipientGroupProps {
  readonly workspaceId: string
  /** The tasks the modal has had unticked to it, of every workspace. */
  readonly unticked: ReadonlySet<string>
  /** Ticks the given tasks (or unticks them), as a row's box was asked. */
  readonly onTick: (taskIds: readonly string[], on: boolean) => void
}

/**
 * A workspace and its tasks the broadcast reaches: its tick box (ticking or unticking all its tasks, a dash when only
 * some are ticked), its badge, its name and how many, then a row for each.
 */
const RecipientGroup = memo(function RecipientGroup({
  workspaceId,
  unticked,
  onTick,
}: RecipientGroupProps): React.JSX.Element {
  const name = useGladeStore((state) => state.workspaces.find(({ id }) => id === workspaceId)?.name)
  const tone = useGladeStore((state) => badgeTone(state.workspaces, workspaceId))
  const taskIds = useGladeStore(useShallow((state) => recipientTaskIds(state, workspaceId)))
  const headingId = useId()
  const tick = workspaceTick(unticked, taskIds)
  return (
    <li className={styles.group}>
      <button
        type="button"
        role="checkbox"
        aria-checked={tick === WorkspaceTick.All ? true : tick === WorkspaceTick.None ? false : 'mixed'}
        aria-label={name}
        id={headingId}
        className={styles.row}
        onClick={() => {
          onTick(taskIds, tick !== WorkspaceTick.All)
        }}
      >
        <TickBox tick={tick} />
        <WorkspaceBadge name={name} tone={tone} size={BadgeSize.Small} />
        <span className={styles.workspaceName}>{name}</span>
        <span className={styles.count}>{taskIds.length}</span>
      </button>
      <ul className={styles.tasks} aria-labelledby={headingId}>
        {taskIds.map((taskId) => (
          <RecipientRow key={taskId} taskId={taskId} ticked={!unticked.has(taskId)} onTick={onTick} />
        ))}
      </ul>
    </li>
  )
})

interface RecipientsProps {
  readonly workspaceIds: readonly string[]
  /** The tasks the modal has had unticked to it, of every workspace. */
  readonly unticked: ReadonlySet<string>
  /** Ticks the given tasks (or unticks them), as a row's box was asked. */
  readonly onTick: (taskIds: readonly string[], on: boolean) => void
}

/** Who the broadcast reaches, grouped by workspace, each row a tick box to take it out or put it back (#675). */
const Recipients = memo(function Recipients({ workspaceIds, unticked, onTick }: RecipientsProps): React.JSX.Element {
  return (
    <ul className={styles.recipients} aria-label="Recipients">
      {workspaceIds.map((workspaceId) => (
        <RecipientGroup key={workspaceId} workspaceId={workspaceId} unticked={unticked} onTick={onTick} />
      ))}
    </ul>
  )
})

function isFailed(outcome: BroadcastOutcome): outcome is BroadcastFailed {
  return outcome.delivery === BroadcastDelivery.Failed
}

interface BroadcastFormProps {
  /** Names the dialog. */
  readonly titleId: string
  readonly fieldRef: React.RefObject<HTMLTextAreaElement | null>
  readonly onClose: () => void
}

/**
 * The modal's content. The message field keeps its own text (it isn't the store's, or this component's state), so
 * typing renders nothing; the recipients each read their own slice of the store. The modal holds the tasks it has had
 * unticked to it — everything else listed is ticked — and starts fresh with none each time it opens (#675), since the
 * form mounts with the modal.
 */
function BroadcastForm({ titleId, fieldRef, onClose }: BroadcastFormProps): React.JSX.Element {
  const total = useGladeStore(recipientCount)
  const workspaceIds = useGladeStore(useShallow(recipientWorkspaceIds))
  const broadcast = useGladeStore((state) => state.broadcast)
  const store = useGladeStoreApi()
  const keymap = useKeymap()
  const toast = useToast()
  const [sending, setSending] = useState(false)
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set())
  const empty = total === 0
  const { tasks: tickedTasks, workspaces: tickedWorkspaces } = useGladeStore(
    useShallow((state) => tickedCounts(state, unticked)),
  )
  const nothingTicked = !empty && tickedTasks === 0

  // One toggle for every row: a task's box ticks or unticks itself, a workspace's all its tasks at once.
  const onTick = useCallback((taskIds: readonly string[], on: boolean) => {
    setUnticked((previous) => setTicked(previous, taskIds, on))
  }, [])

  const send = async (): Promise<void> => {
    const text = fieldRef.current?.value.trim() ?? ''
    if (sending || empty || nothingTicked || text === '') return
    setSending(true)
    try {
      const taskIds = recipientIds(store.getState()).filter((taskId) => !unticked.has(taskId))
      const failures = (await broadcast(text, taskIds)).filter(isFailed)
      // A task that couldn't take it says so, as a failed send does; the rest have it.
      if (failures.length > 0) {
        const { tasks: known } = store.getState()
        toast.show({
          message: undeliveredMessage(
            failures.map(({ taskId, message }) => ({ title: shownTitle(known[taskId]?.title), message })),
          ),
        })
      }
      onClose()
    } catch (error) {
      toast.show({ message: broadcastFailureMessage(describeFailure(error)) })
      setSending(false)
    }
  }

  // ↵ sends and ⇧↵ adds a line, as in the input bar: its Send binding, should you have changed it.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!isCommandKey(WindowCommandId.Send, keymap, event) || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <>
      <h2 id={titleId} className={styles.title}>
        Broadcast
      </h2>
      <Textarea
        ref={fieldRef}
        label="Broadcast message"
        placeholder="Message every active task…"
        rows={3}
        className={styles.field}
        disabled={empty}
        onKeyDown={onKeyDown}
      />
      {empty ? (
        <p className={styles.reach}>{NO_RECIPIENTS}</p>
      ) : nothingTicked ? (
        <p className={styles.reach}>{NOTHING_TICKED}</p>
      ) : (
        <p className={styles.reach}>
          Goes to <span className={styles.reached}>{reachText(tickedTasks, total, tickedWorkspaces)}</span>. {BUSY_NOTE}
        </p>
      )}
      {!empty && <Recipients workspaceIds={workspaceIds} unticked={unticked} onTick={onTick} />}
      <div className={styles.actions}>
        <span className={styles.hint}>
          <Kbd>Esc</Kbd>to cancel
        </span>
        <Button
          variant={ButtonVariant.Primary}
          icon={faArrowUp}
          className={styles.send}
          disabled={empty || nothingTicked || sending}
          onClick={() => {
            void send()
          }}
        >
          Send
        </Button>
      </div>
    </>
  )
}

/**
 * The Broadcast modal (⌘⇧B; `docs/design/screens/45-broadcast.png`): one message to the active tasks you've
 * ticked, in every workspace (#675). It lists them by workspace as tick boxes — a workspace's box ticks or unticks
 * all its tasks, and shows a dash when only some are ticked — everything ticked when the modal opens, and says what's
 * ticked before it's sent. ↵ or Send sends it to the ticked ones and closes the modal; Esc or a click outside closes
 * it without sending, and what was typed goes with it. With nothing ticked it says so, and can't send; with no active
 * task anywhere it says that too. It shows while the store has it open (`broadcastOpen`), taking the focus in its
 * message field and giving it back when it closes.
 */
export function BroadcastDialog(): React.JSX.Element | null {
  const open = useGladeStore((state) => state.broadcastOpen)
  const closeBroadcast = useGladeStore((state) => state.closeBroadcast)
  const titleId = useId()
  const field = useRef<HTMLTextAreaElement>(null)
  const overlay = useOverlayRef()
  useModalPresence(open)
  const { refs, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) closeBroadcast()
    },
  })
  const setFloating = useCallback(
    (node: HTMLElement | null) => {
      refs.setFloating(node)
    },
    [refs],
  )
  const { getFloatingProps } = useInteractions([
    useDismiss(context, { outsidePressEvent: 'mousedown' }),
    useRole(context, { role: 'dialog' }),
  ])
  if (!open) return null
  return (
    <FloatingPortal>
      <FloatingOverlay ref={overlay} className={styles.backdrop} lockScroll>
        <FloatingFocusManager context={context} initialFocus={field}>
          <div ref={setFloating} className={styles.dialog} aria-labelledby={titleId} {...getFloatingProps()}>
            <BroadcastForm titleId={titleId} fieldRef={field} onClose={closeBroadcast} />
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  )
}
