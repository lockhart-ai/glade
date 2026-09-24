/**
 * What the chat shows, worked out from a task's logs. The chat log holds only the user's messages and the agent's final
 * reply per turn; the tool log (narration, tool calls, dividers) never appears in the chat except as the working line's
 * latest narration and the tool-call count under each reply.
 */
import {
  MessageRole,
  TaskActivity,
  TaskState,
  ToolEventKind,
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

export interface UserEntry {
  readonly role: MessageRole.User
  readonly message: Message
}

export interface AgentEntry {
  readonly role: MessageRole.Agent
  readonly message: Message
  readonly style: ReplyStyle
  /** The top-level tool calls made in the reply's turn. */
  readonly toolCalls: number
}

/** One message in the chat. */
export type ChatEntry = UserEntry | AgentEntry

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

/** The chat's entries for a task: each message in order, with each agent reply's style and tool-call count. */
export function chatEntries(task: Task, messages: readonly Message[], toolEvents: readonly ToolEvent[]): ChatEntry[] {
  const counts = toolCallsByTurn(toolEvents)
  const last = messages.at(-1)
  return messages.map((message): ChatEntry => {
    switch (message.role) {
      case MessageRole.User:
        return { role: MessageRole.User, message }
      case MessageRole.Agent:
        return {
          role: MessageRole.Agent,
          message,
          style: message === last && isWaitingOnYou(task) ? ReplyStyle.Question : ReplyStyle.Plain,
          toolCalls: counts.get(message.turn) ?? 0,
        }
    }
  })
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

/** A message's time of day, as the chat shows it: 24-hour local time, "09:05". */
export function clockTime(at: EpochMs): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
