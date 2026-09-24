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
  compactedLabel,
  markedDoneLabel,
  REOPENED_LABEL,
  ReplyStyle,
  restartLabel,
  summaryLine,
  isStoppedByError,
  toolCallLabel,
  workingLabel,
  workingNarration,
  type AgentEntry,
  type MarkedDoneEntry,
  type RestartedEntry,
  type SummaryLine,
  type UserEntry,
} from './chatModel'
import { shortenHomePath } from '../paths'
import { ErrorCard } from './ErrorCard'
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

interface TurnSummaryProps {
  readonly line: SummaryLine
}

/** "Finished in 24m 10s · 4 files +61 −3", beside the tool-call chip. */
function TurnSummary({ line }: TurnSummaryProps): React.JSX.Element {
  return (
    <span role="note" aria-label="Turn summary" className={styles.summary}>
      {line.text}
      {line.lines !== null && (
        <>
          {' '}
          <span className={styles.added}>{line.lines.added}</span>{' '}
          <span className={styles.removed}>{line.lines.removed}</span>
        </>
      )}
    </span>
  )
}

function AgentReply({ entry: { message, style, toolCalls }, onShowTurn }: AgentReplyProps): React.JSX.Element {
  const summary = message.summary === null ? null : summaryLine(message.summary)
  return (
    <article aria-label="Agent" className={styles.agent}>
      <Markdown
        source={message.body}
        className={classNames(styles.reply, style === ReplyStyle.Question && styles.question)}
      />
      {(toolCalls > 0 || summary !== null) && (
        <div className={styles.turn}>
          {toolCalls > 0 && (
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
          )}
          {summary !== null && <TurnSummary line={summary} />}
        </div>
      )}
      <span className={styles.meta}>agent · {clockTime(message.createdAt)}</span>
    </article>
  )
}

interface ChatDividerProps {
  /** The divider's accessible name. */
  readonly name: string
  readonly children: string
}

/** A label between two rules, across the conversation. */
function ChatDivider({ name, children }: ChatDividerProps): React.JSX.Element {
  return (
    <div role="separator" aria-label={name} className={styles.divider}>
      {children}
    </div>
  )
}

/** Where the app restarted and resumed a turn. */
function RestartDivider(entry: RestartedEntry): React.JSX.Element {
  return <ChatDivider name="Glade restarted">{restartLabel(entry)}</ChatDivider>
}

/** Where the task was marked done, before the message that reopened it. */
function MarkedDoneDivider(entry: MarkedDoneEntry): React.JSX.Element {
  return <ChatDivider name="Marked done">{markedDoneLabel(entry)}</ChatDivider>
}

interface WorkingLineProps {
  /** What it says (`workingLabel`). */
  readonly label: string
}

/** The live line while a turn runs. */
function WorkingLine({ label }: WorkingLineProps): React.JSX.Element {
  return (
    <div role="status" className={styles.working}>
      <span className={styles.dots} aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className={styles.workingText}>{label}</span>
    </div>
  )
}

interface NewTaskPromptProps {
  /** The task's workspace root, where the agent works. */
  readonly root: string
}

/** What a task shows before its first message: what to write, and where the agent will work. */
function NewTaskPrompt({ root }: NewTaskPromptProps): React.JSX.Element {
  return (
    <div className={styles.prompt}>
      <h2 className={styles.promptTitle}>What should the agent do?</h2>
      <p className={styles.promptText}>
        Describe it in your own words. The agent names the task and writes its objective from your first message. It
        works in the workspace root, {shortenHomePath(root)}.
      </p>
    </div>
  )
}

/**
 * The selected task's conversation: your messages and the agent's final reply per turn, never anything from within a
 * turn. While a turn runs, a working line shows the agent's latest narration, or which retry of a failed API request
 * is running; when an error stops the agent, its error card ends the conversation. It keeps to the bottom as the
 * conversation grows, unless you've scrolled up.
 */
export function Chat(): React.JSX.Element {
  const task = useGladeStore(selectSelectedTask)
  const messages = useGladeStore((state) => (task === undefined ? undefined : state.messages[task.id])) ?? NO_MESSAGES
  const toolEvents =
    useGladeStore((state) => (task === undefined ? undefined : state.toolEvents[task.id])) ?? NO_TOOL_EVENTS
  const focusTurn = useGladeStore((state) => state.focusTurn)
  const root = useGladeStore(
    (state) => state.workspaces.find((workspace) => workspace.id === task?.workspaceId)?.rootPath,
  )

  const entries = useMemo(
    () => (task === undefined ? [] : chatEntries(task, messages, toolEvents)),
    [task, messages, toolEvents],
  )
  const narration = task === undefined ? null : workingNarration(task, messages, toolEvents)
  const working = task === undefined || narration === null ? null : workingLabel(task, narration)
  const stopped = task !== undefined && isStoppedByError(task)
  const { ref, onScroll } = useStickToBottom(`${String(entries.length)}:${working ?? ''}:${String(stopped)}`, task?.id)
  const isNew = task !== undefined && entries.length === 0 && narration === null

  return (
    <div ref={ref} onScroll={onScroll} role="log" aria-label="Conversation" className={styles.scroller}>
      {isNew && root !== undefined && <NewTaskPrompt root={root} />}
      <div className={styles.thread}>
        {entries.map((entry) => {
          switch (entry.kind) {
            case ChatEntryKind.User:
              return <UserMessage key={entry.message.id} {...entry} />
            case ChatEntryKind.Restarted:
              return <RestartDivider key={entry.divider.id} {...entry} />
            case ChatEntryKind.MarkedDone:
              return <MarkedDoneDivider key={entry.divider.id} {...entry} />
            case ChatEntryKind.Compacted:
              return (
                <ChatDivider key={entry.compaction.id} name="Compacted">
                  {compactedLabel(entry)}
                </ChatDivider>
              )
            case ChatEntryKind.Reopened:
              return (
                <ChatDivider key={entry.divider.id} name="Reopened">
                  {REOPENED_LABEL}
                </ChatDivider>
              )
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
        {working !== null && <WorkingLine label={working} />}
        {stopped && <ErrorCard key={task.id} task={task} />}
      </div>
    </div>
  )
}
