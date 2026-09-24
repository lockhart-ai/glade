import { faWrench } from '@fortawesome/free-solid-svg-icons'
import { useMemo } from 'react'
import type { Message, ToolEvent } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Icon, IconSize } from '../components'
import { selectSelectedTask } from '../store/state'
import { useGladeStore } from '../store/react'
import {
  ChatEntryKind,
  chatEntries,
  clockTime,
  ReplyStyle,
  restartLabel,
  toolCallLabel,
  workingNarration,
  type AgentEntry,
  type RestartedEntry,
  type UserEntry,
} from './chatModel'
import { Markdown } from './Markdown'
import { useStickToBottom } from './useStickToBottom'
import styles from './Chat.module.css'

const NO_MESSAGES: readonly Message[] = []
const NO_TOOL_EVENTS: readonly ToolEvent[] = []

function UserMessage({ message }: UserEntry): React.JSX.Element {
  return (
    <article aria-label="You" className={styles.user}>
      <div className={styles.bubble}>{message.body}</div>
      <span className={styles.meta}>you · {clockTime(message.createdAt)}</span>
    </article>
  )
}

interface AgentReplyProps {
  readonly entry: AgentEntry
  readonly onShowTurn: (turn: number) => void
}

function AgentReply({ entry: { message, style, toolCalls }, onShowTurn }: AgentReplyProps): React.JSX.Element {
  return (
    <article aria-label="Agent" className={styles.agent}>
      <Markdown
        source={message.body}
        className={classNames(styles.reply, style === ReplyStyle.Question && styles.question)}
      />
      {toolCalls > 0 && (
        <div className={styles.turn}>
          <button
            type="button"
            className={styles.chip}
            title="Show this turn in the tool log"
            onClick={() => {
              onShowTurn(message.turn)
            }}
          >
            <Icon icon={faWrench} size={IconSize.Small} />
            {toolCallLabel(toolCalls)}
          </button>
        </div>
      )}
      <span className={styles.meta}>agent · {clockTime(message.createdAt)}</span>
    </article>
  )
}

/** Where the app restarted and resumed a turn. */
function RestartDivider(entry: RestartedEntry): React.JSX.Element {
  return (
    <div role="separator" aria-label="Glade restarted" className={styles.restart}>
      {restartLabel(entry)}
    </div>
  )
}

interface WorkingLineProps {
  /** The turn's latest narration; empty before the first. */
  readonly narration: string
}

/** The live line while a turn runs. */
function WorkingLine({ narration }: WorkingLineProps): React.JSX.Element {
  return (
    <div role="status" className={styles.working}>
      <span className={styles.dots} aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className={styles.workingText}>{narration === '' ? 'Working' : `Working · ${narration}`}</span>
    </div>
  )
}

/**
 * The selected task's conversation: your messages and the agent's final reply per turn, never anything from within a
 * turn. While a turn runs, a working line shows the agent's latest narration. It keeps to the bottom as the
 * conversation grows, unless you've scrolled up.
 */
export function Chat(): React.JSX.Element {
  const task = useGladeStore(selectSelectedTask)
  const messages = useGladeStore((state) => (task === undefined ? undefined : state.messages[task.id])) ?? NO_MESSAGES
  const toolEvents =
    useGladeStore((state) => (task === undefined ? undefined : state.toolEvents[task.id])) ?? NO_TOOL_EVENTS
  const focusTurn = useGladeStore((state) => state.focusTurn)

  const entries = useMemo(
    () => (task === undefined ? [] : chatEntries(task, messages, toolEvents)),
    [task, messages, toolEvents],
  )
  const narration = task === undefined ? null : workingNarration(task, messages, toolEvents)
  const { ref, onScroll } = useStickToBottom(`${String(entries.length)}:${narration ?? ''}`, task?.id)

  return (
    <div ref={ref} onScroll={onScroll} role="log" aria-label="Conversation" className={styles.scroller}>
      <div className={styles.thread}>
        {task !== undefined && entries.length === 0 && narration === null && (
          <p className={styles.empty}>No messages yet.</p>
        )}
        {entries.map((entry) => {
          switch (entry.kind) {
            case ChatEntryKind.User:
              return <UserMessage key={entry.message.id} {...entry} />
            case ChatEntryKind.Restarted:
              return <RestartDivider key={entry.divider.id} {...entry} />
            case ChatEntryKind.Agent:
              return (
                <AgentReply
                  key={entry.message.id}
                  entry={entry}
                  onShowTurn={(turn) => {
                    focusTurn(entry.message.taskId, turn)
                  }}
                />
              )
          }
        })}
        {narration !== null && <WorkingLine narration={narration} />}
      </div>
    </div>
  )
}
