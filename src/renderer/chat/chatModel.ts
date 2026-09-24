/**
 * What the chat shows, worked out from a task's logs. The chat log holds only the user's messages and the agent's final
 * reply per turn; the tool log (narration, tool calls, dividers) never appears in the chat except as the working line's
 * latest narration, the tool-call count under each reply, and three of its dividers: "Glade restarted" where a turn was
 * resumed after the app quit (`docs/design/html/18-relaunch.html`), and "Marked done" and "Reopened by your message"
 * where a message reopened a done task (`docs/design/html/06-reopen.html`).
 */
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolEventKind,
  type DividerEvent,
  type EpochMs,
  type Message,
  type NarrationEvent,
  type Task,
  type ToolEvent,
} from '../../shared/domain'

/** How an agent reply is styled. */
export enum ReplyStyle {
  /** Plain text on the card. */
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

/** One entry in the chat: a message, or a divider. */
export type ChatEntry = UserEntry | AgentEntry | RestartedEntry | MarkedDoneEntry | ReopenedEntry

/** The chat's entries that are dividers. */
export type DividerEntry = RestartedEntry | MarkedDoneEntry | ReopenedEntry

/** The turn in progress or last run: the latest message's turn, or 0 before any message. */
export function currentTurn(messages: readonly Message[]): number {
  return messages.reduce((turn, message) => Math.max(turn, message.turn), 0)
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

/**
 * Whether a divider shows before a message. A marked done divider closes its turn, so it goes before the next turn's
 * message; a restart or reopened divider goes after its turn's message and before its reply.
 */
function dividerComesBefore({ kind, divider }: DividerEntry, message: Message): boolean {
  if (kind === ChatEntryKind.MarkedDone) return message.turn > divider.turn
  return message.turn > divider.turn || (message.turn === divider.turn && message.role === MessageRole.Agent)
}

/**
 * The chat's entries for a task: each message in order, with each agent reply's style and tool-call count, and its
 * dividers in log order: a restart divider for each resumed turn and a reopened divider for each reopening message,
 * each after its turn's message and before its reply, and a marked done divider before each reopening message.
 */
export function chatEntries(task: Task, messages: readonly Message[], toolEvents: readonly ToolEvent[]): ChatEntry[] {
  const counts = toolCallsByTurn(toolEvents)
  const last = messages.at(-1)
  const turn = currentTurn(messages)
  const dividers = toolEvents.flatMap((event) => {
    const entry = event.kind === ToolEventKind.Divider ? dividerEntry(task, event, turn) : null
    return entry === null ? [] : [entry]
  })
  const entries: ChatEntry[] = []
  /** Adds the dividers that go before `message`, or all that are left. */
  const addDividers = (message?: Message): void => {
    for (let divider = dividers[0]; divider !== undefined; divider = dividers[0]) {
      if (message !== undefined && !dividerComesBefore(divider, message)) return
      dividers.shift()
      entries.push(divider)
    }
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
 * What the working line says while a turn runs: the latest narration of the current turn, or null when the task isn't
 * working. The narration is empty until the agent's first note of the turn arrives.
 */
export function workingNarration(
  task: Task,
  messages: readonly Message[],
  toolEvents: readonly ToolEvent[],
): string | null {
  if (task.activity !== TaskActivity.Working) return null
  const turn = currentTurn(messages)
  const latest = toolEvents.findLast(
    (event): event is NarrationEvent => event.kind === ToolEventKind.Narration && event.turn === turn,
  )
  return latest?.text ?? ''
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
