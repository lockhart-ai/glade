import { faWrench } from '@fortawesome/free-solid-svg-icons'
import { useMemo, useRef } from 'react'
import {
  PermissionRequestState,
  type Message,
  type PermissionRequest,
  type QuestionSet,
  type ToolEvent,
} from '../../shared/domain'
import { classNames } from '../components/classNames'
import { Icon, IconSize } from '../components'
import { agentReplyMenu, ContextMenu, useContextMenu, useMenuCommands } from '../context-menus'
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
  quoted,
  toolCallLabel,
  workingLabel,
  workingNarration,
  type AgentEntry,
  type MarkedDoneEntry,
  type PermissionEntry,
  type QuestionEntry,
  type RestartedEntry,
  type SummaryLine,
  type UserEntry,
} from './chatModel'
import { shortenHomePath } from '../paths'
import { isPaused, pausedChatLine } from '../pause/pauseModel'
import { useNow } from '../task-list/useNow'
import { QuestionCard } from '../questions/QuestionCard'
import { PermissionCard } from '../permissions/PermissionCard'
import { subagentOrigin } from '../permissions/permissionCardModel'
import { ErrorCard } from './ErrorCard'
import { Markdown } from './Markdown'
import { StoredImage } from '../images/StoredImage'
import { Highlighted, useSearchHighlight } from '../search/Highlight'
import { useRevealMatch } from '../search/useRevealMatch'
import { useStickToBottom } from './useStickToBottom'
import styles from './Chat.module.css'

const NO_MESSAGES: readonly Message[] = []
const NO_TOOL_EVENTS: readonly ToolEvent[] = []
const NO_QUESTION_SETS: readonly QuestionSet[] = []
const NO_PERMISSION_REQUESTS: readonly PermissionRequest[] = []

/** What the sidebar's search marks in the chat (`useSearchHighlight`). */
interface HighlightProps {
  readonly highlight: RegExp | null
}

function UserMessage({ message, highlight }: UserEntry & HighlightProps): React.JSX.Element {
  return (
    <article aria-label="You" className={styles.user}>
      {message.images.length > 0 && (
        <div className={styles.images}>
          {message.images.map((image) => (
            <StoredImage key={image.id} image={image} className={styles.image} />
          ))}
        </div>
      )}
      {message.body !== '' && (
        <div className={styles.bubble}>
          <Highlighted text={message.body} pattern={highlight} />
        </div>
      )}
      <span className={styles.meta}>you · {clockTime(message.createdAt)}</span>
    </article>
  )
}

interface AgentReplyProps extends HighlightProps {
  readonly entry: AgentEntry
  readonly onShowTurn: (turn: number) => void
  /** Adds text to the message field (Quote in reply). */
  readonly onQuote: (text: string) => void
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

/**
 * One of the agent's replies, with its turn's tool-call chip and summary. Right-click it, or ⇧F10 on it, for its menu:
 * copy it as text or Markdown, quote it in your reply, or show its turn in the tool log.
 */
function AgentReply({ entry, onShowTurn, onQuote, highlight }: AgentReplyProps): React.JSX.Element {
  const { message, style, toolCalls } = entry
  const summary = message.summary === null ? null : summaryLine(message.summary)
  const menu = useContextMenu<AgentEntry>()
  const { copy } = useMenuCommands()
  const rendered = useRef<HTMLDivElement>(null)
  const entries = () =>
    agentReplyMenu(entry, {
      // The reply as it reads on screen, without its Markdown.
      copy: () => {
        copy(rendered.current?.innerText.trim() ?? message.body)
      },
      copyMarkdown: () => {
        copy(message.body)
      },
      quote: () => {
        onQuote(quoted(message.body))
      },
      showToolCalls: () => {
        onShowTurn(message.turn)
      },
    })
  return (
    <article aria-label="Agent" className={styles.agent} tabIndex={0} {...menu.targetProps(entry)}>
      <Markdown
        ref={rendered}
        source={message.body}
        highlight={highlight}
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
      <ContextMenu label="Reply actions" state={menu} entries={entries} />
    </article>
  )
}

/** The agent's questions: what it said just before asking, if anything, then the question card. */
function AgentQuestions({ questionSet, lead, highlight }: QuestionEntry & HighlightProps): React.JSX.Element {
  return (
    <div className={styles.agent}>
      {lead !== null && <Markdown source={lead} className={styles.reply} highlight={highlight} />}
      <QuestionCard questionSet={questionSet} />
      <span className={styles.meta}>agent · {clockTime(questionSet.createdAt)}</span>
    </div>
  )
}

interface AgentPermissionProps extends PermissionEntry {
  readonly toolEvents: readonly ToolEvent[]
  readonly rootPath: string | undefined
  /** Whether it's the first open card in the chat, which takes the focus. */
  readonly first: boolean
}

/** A tool call of the agent's (or a subagent's) waiting, or that waited, on your OK: the permission card. */
function AgentPermission({ request, toolEvents, rootPath, first }: AgentPermissionProps): React.JSX.Element {
  return (
    <div className={styles.agent}>
      <PermissionCard
        request={request}
        rootPath={rootPath}
        subagent={subagentOrigin(request, toolEvents)}
        autoFocus={first}
      />
      {request.state === PermissionRequestState.Open && (
        <span className={styles.meta}>agent · {clockTime(request.createdAt)}</span>
      )}
    </div>
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

interface PausedLineProps {
  /** What it says (`pausedChatLine`). */
  readonly label: string
}

/** The line that ends the chat while the task's turn is paused: when it resumes. */
function PausedLine({ label }: PausedLineProps): React.JSX.Element {
  return (
    <div role="status" aria-label="Paused" className={styles.paused}>
      <span className={styles.pausedDot} aria-hidden />
      {label}
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
 * is running; when an error stops the agent, its error card ends the conversation, and while its turn is paused, a
 * paused line saying when it resumes. It keeps to the bottom as the
 * conversation grows, unless you've scrolled up.
 */
export function Chat(): React.JSX.Element {
  const task = useGladeStore(selectSelectedTask)
  const messages = useGladeStore((state) => (task === undefined ? undefined : state.messages[task.id])) ?? NO_MESSAGES
  const toolEvents =
    useGladeStore((state) => (task === undefined ? undefined : state.toolEvents[task.id])) ?? NO_TOOL_EVENTS
  const focusTurn = useGladeStore((state) => state.focusTurn)
  const insertIntoInput = useGladeStore((state) => state.insertIntoInput)
  const questionSets =
    useGladeStore((state) => (task === undefined ? undefined : state.questionSets[task.id])) ?? NO_QUESTION_SETS
  const permissionRequests =
    useGladeStore((state) => (task === undefined ? undefined : state.permissionRequests[task.id])) ??
    NO_PERMISSION_REQUESTS
  const root = useGladeStore(
    (state) => state.workspaces.find((workspace) => workspace.id === task?.workspaceId)?.rootPath,
  )

  const entries = useMemo(
    () => (task === undefined ? [] : chatEntries(task, messages, toolEvents, questionSets, permissionRequests)),
    [task, messages, toolEvents, questionSets, permissionRequests],
  )
  // The first open permission card takes the focus; once it's answered, the next one does.
  const firstOpen = permissionRequests.find(({ state }) => state === PermissionRequestState.Open)?.id
  const narration = task === undefined ? null : workingNarration(task, messages, toolEvents)
  const working = task === undefined || narration === null ? null : workingLabel(task, narration)
  const stopped = task !== undefined && isStoppedByError(task)
  const now = useNow()
  const paused = task !== undefined && isPaused(task) ? pausedChatLine(task.pause, now) : null
  const { ref, onScroll } = useStickToBottom(
    `${String(entries.length)}:${working ?? ''}:${String(stopped)}:${paused ?? ''}:${questionSets.map(({ state }) => state).join()}:${permissionRequests.map(({ state }) => state).join()}`,
    task?.id,
  )
  const isNew = task !== undefined && entries.length === 0 && narration === null
  const highlight = useSearchHighlight()
  useRevealMatch(ref)

  return (
    <div ref={ref} onScroll={onScroll} role="log" aria-label="Conversation" className={styles.scroller}>
      {isNew && root !== undefined && <NewTaskPrompt root={root} />}
      <div className={styles.thread}>
        {entries.map((entry) => {
          switch (entry.kind) {
            case ChatEntryKind.User:
              return <UserMessage key={entry.message.id} {...entry} highlight={highlight} />
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
            case ChatEntryKind.Question:
              return <AgentQuestions key={entry.questionSet.id} {...entry} highlight={highlight} />
            case ChatEntryKind.Permission:
              return (
                <AgentPermission
                  key={entry.request.id}
                  {...entry}
                  toolEvents={toolEvents}
                  rootPath={root}
                  first={entry.request.id === firstOpen}
                />
              )
            case ChatEntryKind.Agent:
              return (
                <AgentReply
                  key={entry.message.id}
                  entry={entry}
                  highlight={highlight}
                  onShowTurn={(turn) => {
                    focusTurn(entry.message.taskId, turn)
                  }}
                  onQuote={(text) => {
                    insertIntoInput(entry.message.taskId, text)
                  }}
                />
              )
          }
        })}
        {working !== null && <WorkingLine label={working} />}
        {stopped && <ErrorCard key={task.id} task={task} />}
        {paused !== null && <PausedLine label={paused} />}
      </div>
    </div>
  )
}
