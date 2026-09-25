/**
 * A Claude Code session, read from its transcript into what Glade would have logged had it run the session itself
 * (`docs/control-api.md`, "Importing Claude Code sessions"):
 *
 * - Each prompt of yours starts a turn, at the prompt's time.
 * - Per turn, the agent's text is held back as the runner holds it: a tool call after it makes it narration, and what
 *   is left when the turn ends is the final reply.
 * - Each tool call has its input and, once its result is found, its output: done, or failed as the result says. A call
 *   with no result is interrupted.
 * - A compaction is a compaction row in the turn it happened in.
 * - Left out: subagents' entries (`isSidechain`), thinking, Claude Code's meta messages, the summary a compaction
 *   leaves, slash commands and their output, interruption markers, and images, which are counted.
 *
 * The transcript is fed in an entry at a time (`SessionReader.add`), so a long one is never all in memory as text.
 */
import { CompactionTrigger, type EpochMs, type ToolInput } from '../../../shared/domain'
import {
  AssistantBlockKind,
  TranscriptEntryKind,
  UserBlockKind,
  type AssistantEntry,
  type CompactionEntry,
  type TranscriptEntry,
  type UserEntry,
} from './entries'

/**
 * Text Claude Code writes on your side that isn't a prompt: a tag (`<command-name>`, `<local-command-stdout>`,
 * `<bash-input>`, …: slash commands, their output and shell mode) or an interruption marker. The same test Claude Code
 * uses when it picks a session's first prompt.
 */
const NOT_A_PROMPT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/** What stands in for a prompt that was only images, which Glade leaves out. */
export const IMAGE_ONLY_PROMPT = '[Image]'

/** A text of the session, with when it was written. */
export interface TimedText {
  readonly text: string
  readonly at: EpochMs
}

/** The kinds of entry in an imported turn's tool log. */
export enum SessionLogKind {
  Narration = 'narration',
  ToolCall = 'tool_call',
  Compaction = 'compaction',
}

export interface SessionNarration {
  readonly kind: SessionLogKind.Narration
  readonly text: string
  readonly at: EpochMs
}

/** A tool call's result, as the transcript has it. */
export interface SessionToolResult {
  readonly output: string
  readonly isError: boolean
  readonly at: EpochMs
}

export interface SessionToolCall {
  readonly kind: SessionLogKind.ToolCall
  readonly toolUseId: string
  readonly name: string
  readonly input: ToolInput
  readonly at: EpochMs
  /** Null when the transcript has none: the call was interrupted. */
  readonly result: SessionToolResult | null
}

export interface SessionCompaction {
  readonly kind: SessionLogKind.Compaction
  readonly trigger: CompactionTrigger
  readonly preTokens: number | null
  readonly postTokens: number | null
  readonly at: EpochMs
}

export type SessionLogEntry = SessionNarration | SessionToolCall | SessionCompaction

export interface SessionTurn {
  /** From 1. */
  readonly number: number
  /** Your prompt; null for a turn with none, e.g. what the agent did before the first one. */
  readonly prompt: TimedText | null
  readonly log: readonly SessionLogEntry[]
  /** The agent's final reply; null when the turn ended on a tool call, or with no text at all. */
  readonly reply: TimedText | null
}

/** What Glade left out of a session, to tell whoever imported it. */
export interface SkippedCounts {
  /** Lines that weren't JSON, or weren't an entry Glade knows. */
  readonly lines: number
  readonly images: number
}

/** A session read from its transcript. */
export interface ClaudeCodeTranscript {
  /** The folder the session ran in; null when no entry says. */
  readonly cwd: string | null
  /** Claude Code's own title for the session: the one you gave it, else its latest AI title, else an older summary. */
  readonly title: string | null
  /** Your first prompt; null when there's none. */
  readonly firstPrompt: string | null
  /** The model the agent last ran on, as the API names it; null when no entry says. */
  readonly model: string | null
  readonly startedAt: EpochMs
  readonly lastActivityAt: EpochMs
  readonly turns: readonly SessionTurn[]
  /** Your prompts plus the agent's final replies: the messages the chat will hold. */
  readonly messages: number
  readonly skipped: SkippedCounts
}

/** A turn as it's read, before it ends. */
interface OpenTurn {
  readonly number: number
  readonly prompt: TimedText | null
  readonly log: SessionLogEntry[]
  /** The agent's text since its last tool call, held back until a tool call or the turn's end says what it is. */
  readonly pending: TimedText[]
  /**
   * Where in the log the held-back text began. Only compactions can follow it there, so narration goes in before them,
   * where it was said.
   */
  pendingFrom: number
  reply: TimedText | null
}

/** Which of a run of texts' times a joined text takes. */
enum JoinedAt {
  First = 'first',
  Last = 'last',
}

/** Held-back texts, joined as the runner joins them, at the first's or last's time; null when there's nothing to say. */
function joined(texts: readonly TimedText[], at: JoinedAt): TimedText | null {
  const text = texts
    .map((part) => part.text)
    .join('\n\n')
    .trim()
  const timed = at === JoinedAt.First ? texts[0] : texts[texts.length - 1]
  if (text === '' || timed === undefined) return null
  return { text, at: timed.at }
}

/** Builds a session from its transcript's entries, in order. */
export class SessionReader {
  private readonly turns: OpenTurn[] = []
  /** The tool calls waiting on a result, by `tool_use` id: a result pairs with its call wherever it comes. */
  private readonly calls = new Map<string, { turn: OpenTurn; index: number }>()
  private cwd: string | null = null
  private customTitle: string | null = null
  private aiTitle: string | null = null
  private summary: string | null = null
  private model: string | null = null
  private startedAt: EpochMs | null = null
  private lastAt: EpochMs | null = null
  private skippedLines = 0
  private images = 0

  /** @param fallbackTime When entries that don't say when they were written happened, before any that does. */
  constructor(private readonly fallbackTime: EpochMs) {}

  /** Counts a line Glade skipped. */
  skipLine(): void {
    this.skippedLines += 1
  }

  add(entry: TranscriptEntry): void {
    switch (entry.kind) {
      case TranscriptEntryKind.AiTitle:
        this.aiTitle = entry.title
        return
      case TranscriptEntryKind.CustomTitle:
        this.customTitle = entry.title
        return
      case TranscriptEntryKind.Summary:
        this.summary = entry.title
        return
      case TranscriptEntryKind.User:
      case TranscriptEntryKind.Assistant:
      case TranscriptEntryKind.Compaction:
        break
    }
    if (entry.sidechain) return
    this.cwd ??= entry.cwd
    const at = entry.at ?? this.lastAt ?? this.fallbackTime
    this.startedAt ??= at
    this.lastAt = Math.max(at, this.lastAt ?? at)
    switch (entry.kind) {
      case TranscriptEntryKind.User:
        this.addUser(entry, at)
        return
      case TranscriptEntryKind.Assistant:
        this.addAssistant(entry, at)
        return
      case TranscriptEntryKind.Compaction:
        this.addCompaction(entry, at)
        return
    }
  }

  /** The session as read so far. */
  finish(): ClaudeCodeTranscript {
    const turns = this.turns.map((turn): SessionTurn => {
      const reply = turn.reply ?? joined(turn.pending, JoinedAt.Last)
      return { number: turn.number, prompt: turn.prompt, log: [...turn.log], reply }
    })
    const firstPrompt = turns.find((turn) => turn.prompt !== null)?.prompt?.text ?? null
    const startedAt = this.startedAt ?? this.fallbackTime
    return {
      cwd: this.cwd,
      title: this.customTitle ?? this.aiTitle ?? this.summary,
      firstPrompt,
      model: this.model,
      startedAt,
      lastActivityAt: this.lastAt ?? startedAt,
      turns,
      messages: turns.reduce((sum, turn) => sum + (turn.prompt === null ? 0 : 1) + (turn.reply === null ? 0 : 1), 0),
      skipped: { lines: this.skippedLines, images: this.images },
    }
  }

  /** The turn being read, opening one with no prompt when the agent does something before your first. */
  private current(): OpenTurn {
    return this.turns[this.turns.length - 1] ?? this.open(null)
  }

  private open(prompt: TimedText | null): OpenTurn {
    const last = this.turns[this.turns.length - 1]
    if (last !== undefined) this.close(last)
    const turn: OpenTurn = { number: this.turns.length + 1, prompt, log: [], pending: [], pendingFrom: 0, reply: null }
    this.turns.push(turn)
    return turn
  }

  /** Ends a turn: what the agent still held back is its final reply. */
  private close(turn: OpenTurn): void {
    turn.reply = joined(turn.pending.splice(0), JoinedAt.Last)
  }

  /** Saves the held-back text as narration, if there is any. */
  private flushNarration(turn: OpenTurn): void {
    const narration = joined(turn.pending.splice(0), JoinedAt.First)
    if (narration !== null) turn.log.splice(turn.pendingFrom, 0, { kind: SessionLogKind.Narration, ...narration })
  }

  private addUser(entry: UserEntry, at: EpochMs): void {
    let texts: string[] = []
    let images = 0
    for (const block of entry.blocks) {
      switch (block.kind) {
        case UserBlockKind.Text:
          texts.push(block.text)
          break
        case UserBlockKind.Image:
          images += 1
          break
        case UserBlockKind.ToolResult:
          images += block.images
          this.addResult(block.toolUseId, { output: block.output, isError: block.isError, at })
          break
      }
    }
    this.images += images
    if (entry.meta || entry.compactSummary) return
    texts = texts.filter((text) => !NOT_A_PROMPT.test(text))
    const text = texts.join('\n\n').trim()
    const hasResults = entry.blocks.some((block) => block.kind === UserBlockKind.ToolResult)
    if (text !== '') this.open({ text, at })
    else if (images > 0 && !hasResults) this.open({ text: IMAGE_ONLY_PROMPT, at })
  }

  private addResult(toolUseId: string, result: SessionToolResult): void {
    const waiting = this.calls.get(toolUseId)
    if (waiting === undefined) return
    this.calls.delete(toolUseId)
    const call = waiting.turn.log[waiting.index]
    if (call?.kind === SessionLogKind.ToolCall) waiting.turn.log[waiting.index] = { ...call, result }
  }

  private addAssistant(entry: AssistantEntry, at: EpochMs): void {
    // Claude Code's own stand-in replies (an API error, "No response requested.") say no model of their own.
    if (entry.model !== null && entry.model !== '<synthetic>') this.model = entry.model
    for (const block of entry.blocks) {
      const turn = this.current()
      switch (block.kind) {
        case AssistantBlockKind.Text:
          if (turn.pending.length === 0) turn.pendingFrom = turn.log.length
          turn.pending.push({ text: block.text, at })
          break
        case AssistantBlockKind.ToolUse: {
          this.flushNarration(turn)
          const { toolUseId, name, input } = block
          this.calls.set(toolUseId, { turn, index: turn.log.length })
          turn.log.push({ kind: SessionLogKind.ToolCall, toolUseId, name, input, at, result: null })
          break
        }
      }
    }
  }

  private addCompaction(entry: CompactionEntry, at: EpochMs): void {
    const { trigger, preTokens, postTokens } = entry
    this.current().log.push({ kind: SessionLogKind.Compaction, trigger, preTokens, postTokens, at })
  }
}
