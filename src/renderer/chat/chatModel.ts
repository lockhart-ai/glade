/**
 * What the chat shows, worked out from a task's logs. The chat log holds only the user's messages and the agent's final
 * reply per turn; the tool log (narration, tool calls, dividers) never appears in the chat except as the working line's
 * latest narration, the tool-call count under each reply (beside the turn's summary, saved on the reply), and three of its dividers: "Glade restarted" where a turn was
 * resumed after the app quit (`docs/design/html/18-relaunch.html`), and "Marked done" and "Reopened by your message"
 * where a message reopened a done task (`docs/design/html/06-reopen.html`). Its compactions show as "Compacted ·
 * 198k → 41k" dividers (`docs/design/html/19-compaction.html`). The agent's questions (`ask`) show as question cards
 * where they were asked (`docs/design/html/03-rich-question.html`), each led by the narration the agent wrote just
 * before asking, if any. The tool calls that wait on your OK show as permission cards where they asked
 * (`docs/design/html/23-permission-card.html`).
 */
import { formatTokens } from '../context-meter/format'
import {
  CompactionTrigger,
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type CompactionEvent,
  type DividerEvent,
  type EpochMs,
  type Message,
  type NarrationEvent,
  type PermissionRequest,
  type QuestionSet,
  type Task,
  type ToolEvent,
  type TurnSummary,
} from '../../shared/domain'
import { retryingLabel } from '../../shared/taskError'

/** Which card an agent reply is on. Every reply is on a card, whatever its turn's shape. */
export enum ReplyStyle {
  /** The neutral reply card. */
  Plain = 'plain',
  /** The purple question card: the task's latest reply, and the agent is waiting on you. */
  Question = 'question',
}

/** The variants of a chat entry. */
export enum ChatEntryKind {
  User = 'user',
  Agent = 'agent',
  /** Where the app restarted and resumed a turn. */
  Restarted = 'restarted',
  /** Where the task was marked done, before the message that reopened it. */
  MarkedDone = 'marked_done',
  /** Where your message reopened the task, after that message. */
  Reopened = 'reopened',
  /** Where the context was compacted. */
  Compacted = 'compacted',
  /** The questions the agent asked (`ask`): a question card. */
  Question = 'question',
  /** A tool call that waits, or waited, on your OK: a permission card. */
  Permission = 'permission',
}

export interface UserEntry {
  readonly kind: ChatEntryKind.User
  readonly message: Message
}

export interface AgentEntry {
  readonly kind: ChatEntryKind.Agent
  readonly message: Message
  readonly style: ReplyStyle
  /** The top-level tool calls made in the reply's turn. */
  readonly toolCalls: number
}

export interface RestartedEntry {
  readonly kind: ChatEntryKind.Restarted
  /** The tool log's resumed divider. */
  readonly divider: DividerEvent
  /** Whether the resumed turn is still running. */
  readonly resuming: boolean
}

export interface MarkedDoneEntry {
  readonly kind: ChatEntryKind.MarkedDone
  /** The tool log's marked done divider, stamped with when the task was marked done. */
  readonly divider: DividerEvent
}

export interface ReopenedEntry {
  readonly kind: ChatEntryKind.Reopened
  /** The tool log's reopened divider. */
  readonly divider: DividerEvent
}

export interface CompactedEntry {
  readonly kind: ChatEntryKind.Compacted
  /** The tool log's compaction, finished. */
  readonly compaction: CompactionEvent
}

export interface QuestionEntry {
  readonly kind: ChatEntryKind.Question
  readonly questionSet: QuestionSet
  /** What the agent said just before it asked (the narration right before its `ask` call), or null. */
  readonly lead: string | null
}

export interface PermissionEntry {
  readonly kind: ChatEntryKind.Permission
  readonly request: PermissionRequest
}

/** One entry in the chat: a message, a divider, a question card or a permission card. */
export type ChatEntry =
  | UserEntry
  | AgentEntry
  | RestartedEntry
  | MarkedDoneEntry
  | ReopenedEntry
  | CompactedEntry
  | QuestionEntry
  | PermissionEntry

/** The chat's cards: the agent's questions, and its calls that wait on your OK. */
export type CardEntry = QuestionEntry | PermissionEntry

/** The chat's entries that are dividers. */
export type DividerEntry = RestartedEntry | MarkedDoneEntry | ReopenedEntry | CompactedEntry

/**
 * The turn in progress or last run: the latest message's turn, or the latest turn divider's for a turn the agent started
 * on its own, which has no message until it replies; 0 before either.
 */
export function currentTurn(messages: readonly Message[], toolEvents: readonly ToolEvent[] = []): number {
  const byMessage = messages.reduce((turn, message) => Math.max(turn, message.turn), 0)
  return toolEvents.reduce(
    (turn, event) =>
      event.kind === ToolEventKind.Divider && event.dividerKind === DividerKind.Turn
        ? Math.max(turn, event.turn)
        : turn,
    byMessage,
  )
}

/** The tool calls made in each turn by the agent itself (not by its subagents), by turn. */
export function toolCallsByTurn(toolEvents: readonly ToolEvent[]): ReadonlyMap<number, number> {
  const counts = new Map<number, number>()
  for (const event of toolEvents) {
    if (event.kind === ToolEventKind.ToolCall && event.parentToolUseId === null) {
      counts.set(event.turn, (counts.get(event.turn) ?? 0) + 1)
    }
  }
  return counts
}

/** Whether the agent is waiting on an answer to its latest reply: the task is active and not working or errored. */
function isWaitingOnYou(task: Task): boolean {
  return task.state === TaskState.Active && task.activity === TaskActivity.Waiting
}

/** The chat's entry for a message. */
function messageEntry(task: Task, message: Message, last: Message | undefined, counts: ReadonlyMap<number, number>) {
  switch (message.role) {
    case MessageRole.User:
      return { kind: ChatEntryKind.User, message } satisfies UserEntry
    case MessageRole.Agent:
      return {
        kind: ChatEntryKind.Agent,
        message,
        style: message === last && isWaitingOnYou(task) ? ReplyStyle.Question : ReplyStyle.Plain,
        toolCalls: counts.get(message.turn) ?? 0,
      } satisfies AgentEntry
  }
}

/**
 * The chat's entry for a tool log divider, or null for one it doesn't show (a turn's). `turn` is the chat's current
 * turn, which a restart divider says it's resuming while it runs.
 */
function dividerEntry(task: Task, divider: DividerEvent, turn: number): DividerEntry | null {
  switch (divider.dividerKind) {
    case DividerKind.Turn:
      return null
    case DividerKind.Resumed: {
      const resuming = task.activity === TaskActivity.Working && divider.turn === turn
      return { kind: ChatEntryKind.Restarted, divider, resuming }
    }
    case DividerKind.MarkedDone:
      return { kind: ChatEntryKind.MarkedDone, divider }
    case DividerKind.Reopened:
      return { kind: ChatEntryKind.Reopened, divider }
  }
}

/** The chat's entry for a compaction, or null for one that hasn't finished (or never did). */
function compactionEntry(compaction: CompactionEvent): CompactedEntry | null {
  return compaction.state === ToolCallState.Done ? { kind: ChatEntryKind.Compacted, compaction } : null
}

/** The chat's entry for a tool log entry, or null for one it doesn't show. */
function toolEventEntry(task: Task, event: ToolEvent, turn: number): DividerEntry | null {
  switch (event.kind) {
    case ToolEventKind.Divider:
      return dividerEntry(task, event, turn)
    case ToolEventKind.Compaction:
      return compactionEntry(event)
    case ToolEventKind.Narration:
    case ToolEventKind.ToolCall:
      return null
  }
}

/**
 * Whether a divider shows before a message. A marked done divider closes its turn, so it goes before the next turn's
 * message (or, for a task done before its first turn, before the message of the turn it's in, which came after it); a restart or reopened divider goes after the message that started its turn and before its reply, and
 * before any queued message delivered into the turn after it. A compaction goes where it happened: before the
 * messages of later turns, and of its own turn, those that came after it.
 */
function dividerComesBefore(entry: DividerEntry, message: Message): boolean {
  if (entry.kind === ChatEntryKind.Compacted) {
    const { compaction } = entry
    if (message.turn !== compaction.turn) return message.turn > compaction.turn
    return message.createdAt > compaction.createdAt
  }
  const { kind, divider } = entry
  if (kind === ChatEntryKind.MarkedDone) {
    return message.turn > divider.turn || (message.turn === divider.turn && message.createdAt > divider.createdAt)
  }
  if (message.turn !== divider.turn) return message.turn > divider.turn
  return message.role === MessageRole.Agent || message.createdAt > divider.createdAt
}

/** The name the model calls Glade's `ask` tool by, as the tool log records it. */
const ASK_TOOL = 'mcp__glade__ask'

/**
 * What the agent said just before it asked a question set: the narration of its turn that came right before its `ask`
 * call, or null when something else (another tool call) came between.
 */
export function questionLead(set: QuestionSet, toolEvents: readonly ToolEvent[]): string | null {
  const before = toolEvents.filter(
    (event) =>
      event.turn === set.turn &&
      event.createdAt <= set.createdAt &&
      !(event.kind === ToolEventKind.ToolCall && event.name === ASK_TOOL),
  )
  const last = before.at(-1)
  return last?.kind === ToolEventKind.Narration ? last.text : null
}

/** What a card was made in and when: its question set, or its permission request. */
function cardOrigin(card: CardEntry): Pick<QuestionSet, 'turn' | 'createdAt'> {
  switch (card.kind) {
    case ChatEntryKind.Question:
      return card.questionSet
    case ChatEntryKind.Permission:
      return card.request
  }
}

/** Whether a card shows before a message: before later turns' messages, and its own turn's that came after it. */
function cardComesBefore(card: CardEntry, message: Message): boolean {
  const { turn, createdAt } = cardOrigin(card)
  if (message.turn !== turn) return message.turn > turn
  return message.createdAt > createdAt
}

/** When a divider entry happened, for putting cards among the dividers. */
function dividerTime(entry: DividerEntry): EpochMs {
  return entry.kind === ChatEntryKind.Compacted ? entry.compaction.createdAt : entry.divider.createdAt
}

/**
 * The chat's entries for a task: each message in order, with each agent reply's style and tool-call count, and its
 * dividers in log order: a restart divider for each resumed turn and a reopened divider for each reopening message,
 * each after its turn's message and before its reply, and a marked done divider before each reopening message. Each
 * question set and permission request shows as a card where it was made: after the messages before it, and before the
 * dividers after it, in the order they were made.
 */
export function chatEntries(
  task: Task,
  messages: readonly Message[],
  toolEvents: readonly ToolEvent[],
  questionSets: readonly QuestionSet[] = [],
  permissionRequests: readonly PermissionRequest[] = [],
): ChatEntry[] {
  const counts = toolCallsByTurn(toolEvents)
  const last = messages.at(-1)
  const turn = currentTurn(messages, toolEvents)
  const dividers = toolEvents.flatMap((event) => {
    const entry = toolEventEntry(task, event, turn)
    return entry === null ? [] : [entry]
  })
  const cards = [
    ...questionSets.map((questionSet): CardEntry => ({
      kind: ChatEntryKind.Question,
      questionSet,
      lead: questionLead(questionSet, toolEvents),
    })),
    ...permissionRequests.map((request): CardEntry => ({ kind: ChatEntryKind.Permission, request })),
  ].toSorted((a, b) => cardOrigin(a).createdAt - cardOrigin(b).createdAt)
  const entries: ChatEntry[] = []
  /** Adds the cards that go before `message` (all that are left without one) and before `before`, if given. */
  const addCards = (message: Message | undefined, before?: EpochMs): void => {
    for (let card = cards[0]; card !== undefined; card = cards[0]) {
      if (message !== undefined && !cardComesBefore(card, message)) return
      if (before !== undefined && cardOrigin(card).createdAt > before) return
      cards.shift()
      entries.push(card)
    }
  }
  /** Adds the dividers that go before `message`, or all that are left, with the cards that came first. */
  const addDividers = (message?: Message): void => {
    for (let divider = dividers[0]; divider !== undefined; divider = dividers[0]) {
      if (message !== undefined && !dividerComesBefore(divider, message)) break
      addCards(message, dividerTime(divider))
      dividers.shift()
      entries.push(divider)
    }
    addCards(message)
  }
  for (const message of messages) {
    addDividers(message)
    entries.push(messageEntry(task, message, last, counts))
  }
  addDividers()
  return entries
}

/** What a restart divider says: "Glade restarted · 14:26", and "· resuming" while the turn it resumed runs. */
export function restartLabel({ divider, resuming }: RestartedEntry): string {
  return `Glade restarted · ${clockTime(divider.createdAt)}${resuming ? ' · resuming' : ''}`
}

/**
 * What a compaction divider says: "Compacted · 198k → 41k", or "Compacted automatically at 99% · 198k → 41k" for one
 * the SDK did on its own at its threshold. "from 198k" when the SDK didn't say what was left.
 */
export function compactedLabel({ compaction }: CompactedEntry): string {
  const { trigger, preTokens, postTokens, windowTokens } = compaction
  const before = formatTokens(preTokens ?? 0)
  const tokens = postTokens === null ? `from ${before}` : `${before} → ${formatTokens(postTokens)}`
  switch (trigger) {
    case CompactionTrigger.Manual:
      return `Compacted · ${tokens}`
    case CompactionTrigger.Auto: {
      const percent = windowTokens > 0 ? Math.round(((preTokens ?? 0) / windowTokens) * 100) : 0
      return `Compacted automatically at ${String(percent)}% · ${tokens}`
    }
  }
}

/** What the working line says while the context is being compacted. */
export const COMPACTING_NARRATION = 'Compacting the context'

/**
 * What the working line says while a turn runs: the agent's latest narration of the current turn (not a subagent's),
 * or null when the task isn't working. The narration is empty until the agent's first note of the turn arrives. While
 * the context is being compacted, it says so.
 */
export function workingNarration(
  task: Task,
  messages: readonly Message[],
  toolEvents: readonly ToolEvent[],
): string | null {
  if (task.activity !== TaskActivity.Working) return null
  const last = toolEvents.at(-1)
  if (last?.kind === ToolEventKind.Compaction && last.state === ToolCallState.Running) return COMPACTING_NARRATION
  const turn = currentTurn(messages, toolEvents)
  const latest = toolEvents.findLast(
    (event): event is NarrationEvent =>
      event.kind === ToolEventKind.Narration && event.turn === turn && event.parentToolUseId === null,
  )
  return latest?.text ?? ''
}

/**
 * What the working line says: `Working · <the latest narration>` (just `Working` before the first), or `Retrying (2 of
 * 10)…` while a failed API request is being retried.
 */
export function workingLabel(task: Pick<Task, 'retrying'>, narration: string): string {
  if (task.retrying !== null) return retryingLabel(task.retrying)
  return narration === '' ? 'Working' : `Working · ${narration}`
}

/** Whether an error stopped the task's agent: the chat ends with the error card. */
export function isStoppedByError(task: Pick<Task, 'state' | 'activity'>): boolean {
  return task.state === TaskState.Active && task.activity === TaskActivity.Error
}

/** How long a turn ran: "8s", "24m 10s", "1h 2m", to the nearest second. */
export function durationLabel(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`
}

/** What a turn summary line says, in its parts: the text before the line counts, and the counts, if any. */
export interface SummaryLine {
  /** "Finished in 24m 10s · 4 files", "Finished in 8s", or "1 file" when the duration is unknown. */
  readonly text: string
  /** "+61" and "−3" (a true minus sign), when the turn changed files. */
  readonly lines: { readonly added: string; readonly removed: string } | null
}

/**
 * What the summary under a turn's final reply says: "Finished in 24m 10s · 4 files +61 −3". The files part is left out
 * when the turn changed none, and the duration when it's unknown; null when there's nothing to say.
 */
export function summaryLine(summary: TurnSummary): SummaryLine | null {
  const { durationMs, filesChanged } = summary
  const parts = [
    ...(durationMs === null ? [] : [`Finished in ${durationLabel(durationMs)}`]),
    ...(filesChanged === 0 ? [] : [`${String(filesChanged)} file${filesChanged === 1 ? '' : 's'}`]),
  ]
  if (parts.length === 0) return null
  const lines =
    filesChanged === 0 ? null : { added: `+${String(summary.linesAdded)}`, removed: `−${String(summary.linesRemoved)}` }
  return { text: parts.join(' · '), lines }
}

/** "7 tool calls", "1 tool call". */
export function toolCallLabel(count: number): string {
  return `${String(count)} tool call${count === 1 ? '' : 's'}`
}

/** What a marked done divider says: "Marked done · Sep 23, 11:26". */
export function markedDoneLabel({ divider }: MarkedDoneEntry): string {
  return `Marked done · ${dayAndTime(divider.createdAt)}`
}

/** What a reopened divider says. */
export const REOPENED_LABEL = 'Reopened by your message'

/** A day and time of day: "Sep 23, 11:26". */
export function dayAndTime(at: EpochMs): string {
  const day = new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${day}, ${clockTime(at)}`
}

/** A message's time of day, as the chat shows it: 24-hour local time, "09:05". */
export function clockTime(at: EpochMs): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * A reply quoted for yours (Quote in reply): each line of its Markdown behind `> `, then a blank line to write under.
 */
export function quoted(markdown: string): string {
  const lines = markdown.trim().split('\n')
  return `${lines.map((line) => (line.trim() === '' ? '>' : `> ${line}`)).join('\n')}\n\n`
}
