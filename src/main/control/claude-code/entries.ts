/**
 * The lines of a Claude Code transcript Glade reads when it imports a session (`docs/control-api.md`, "Importing
 * Claude Code sessions"; the shapes are in `docs/sdk-notes.md` §8, "Transcript entries").
 *
 * Each line is one JSON object, parsed on its own with zod into a discriminated union of the entries Glade uses: your
 * side of the conversation (`user`), the agent's (`assistant`), compactions, and the session's titles. Everything else
 * Claude Code writes (attachments, queue operations, costs, …), and any line that isn't JSON or doesn't have the shape
 * Glade expects, is skipped, and counted. Every object is loose, so a field Claude Code adds later changes nothing, and
 * content blocks are checked one at a time, so one Glade doesn't know never spoils its neighbours.
 */
import { z } from 'zod'
import { CompactionTrigger, type EpochMs, type ToolInput } from '../../../shared/domain'

/** The kinds of transcript entry Glade reads. */
export enum TranscriptEntryKind {
  User = 'user',
  Assistant = 'assistant',
  Compaction = 'compaction',
  /** The title Claude Code gave the session. */
  AiTitle = 'ai-title',
  /** The title you gave the session (`/rename`). */
  CustomTitle = 'custom-title',
  /** An older Claude Code's summary of the session, used as its title. */
  Summary = 'summary',
}

/** What every conversation entry (`user`, `assistant`, a compaction) says about where and when it was written. */
export interface ConversationFields {
  /** When it was written; null when the line doesn't say, or says it in a form Glade can't read. */
  readonly at: EpochMs | null
  /** The folder the session ran in; null when the line doesn't say. */
  readonly cwd: string | null
  /** A subagent's entry, not the main conversation's. */
  readonly sidechain: boolean
}

/** A content block of your side of the conversation. */
export enum UserBlockKind {
  Text = 'text',
  Image = 'image',
  ToolResult = 'tool_result',
}

export interface UserTextBlock {
  readonly kind: UserBlockKind.Text
  readonly text: string
}

export interface UserImageBlock {
  readonly kind: UserBlockKind.Image
}

export interface ToolResultBlock {
  readonly kind: UserBlockKind.ToolResult
  readonly toolUseId: string
  /** The result's text: its string content, or its text blocks joined. */
  readonly output: string
  readonly isError: boolean
  /** How many images the result held, which Glade leaves out. */
  readonly images: number
}

export type UserBlock = UserTextBlock | UserImageBlock | ToolResultBlock

export interface UserEntry extends ConversationFields {
  readonly kind: TranscriptEntryKind.User
  /** Claude Code's own message, not yours (e.g. a command's caveat). */
  readonly meta: boolean
  /** The summary a compaction left, which the agent carries on from. */
  readonly compactSummary: boolean
  readonly blocks: readonly UserBlock[]
}

/** A content block of the agent's side of the conversation. */
export enum AssistantBlockKind {
  Text = 'text',
  ToolUse = 'tool_use',
}

export interface AssistantTextBlock {
  readonly kind: AssistantBlockKind.Text
  readonly text: string
}

export interface ToolUseBlock {
  readonly kind: AssistantBlockKind.ToolUse
  readonly toolUseId: string
  readonly name: string
  readonly input: ToolInput
}

export type AssistantBlock = AssistantTextBlock | ToolUseBlock

export interface AssistantEntry extends ConversationFields {
  readonly kind: TranscriptEntryKind.Assistant
  /** The model that wrote it, as the API names it; null when the line doesn't say. */
  readonly model: string | null
  /** Its text and tool calls; anything else (thinking, …) is left out. */
  readonly blocks: readonly AssistantBlock[]
}

export interface CompactionEntry extends ConversationFields {
  readonly kind: TranscriptEntryKind.Compaction
  readonly trigger: CompactionTrigger
  readonly preTokens: number | null
  readonly postTokens: number | null
}

export interface TitleEntry {
  readonly kind: TranscriptEntryKind.AiTitle | TranscriptEntryKind.CustomTitle | TranscriptEntryKind.Summary
  readonly title: string
}

export type TranscriptEntry = UserEntry | AssistantEntry | CompactionEntry | TitleEntry

// A timestamp Glade can't read is as good as a missing one.
const timestamp = z
  .string()
  .optional()
  .catch(undefined)
  .transform((value) => {
    if (value === undefined) return null
    const at = Date.parse(value)
    return Number.isNaN(at) ? null : at
  })

const conversation = {
  timestamp,
  cwd: z.string().optional().catch(undefined),
  isSidechain: z.boolean().optional().catch(undefined),
}

const flag = z.boolean().optional().catch(undefined)
const block = z.looseObject({ type: z.string() })
const textBlock = z.looseObject({ type: z.literal('text'), text: z.string() })
const toolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})
const toolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z
    .union([z.string(), z.array(block)])
    .optional()
    .catch(undefined),
  is_error: flag,
})

const userLine = z.looseObject({
  type: z.literal('user'),
  ...conversation,
  isMeta: flag,
  isCompactSummary: flag,
  message: z.looseObject({ content: z.union([z.string(), z.array(block)]) }),
})

const assistantLine = z.looseObject({
  type: z.literal('assistant'),
  ...conversation,
  message: z.looseObject({ model: z.string().optional().catch(undefined), content: z.array(block) }),
})

const tokens = z.number().int().nonnegative().optional().catch(undefined)

const compactionLine = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  ...conversation,
  compactMetadata: z
    .looseObject({
      trigger: z.enum(CompactionTrigger).optional().catch(undefined),
      preTokens: tokens,
      postTokens: tokens,
    })
    .optional()
    .catch(undefined),
})

const aiTitleLine = z.looseObject({ type: z.literal('ai-title'), aiTitle: z.string() })
const customTitleLine = z.looseObject({ type: z.literal('custom-title'), customTitle: z.string() })
const summaryLine = z.looseObject({ type: z.literal('summary'), summary: z.string() })

const line = z.discriminatedUnion('type', [
  userLine,
  assistantLine,
  compactionLine,
  aiTitleLine,
  customTitleLine,
  summaryLine,
])

function conversationFields(parsed: z.infer<typeof userLine | typeof assistantLine>): ConversationFields {
  return { at: parsed.timestamp, cwd: parsed.cwd ?? null, sidechain: parsed.isSidechain === true }
}

/** Text blocks' text, joined; images counted. */
function resultContent(content: string | readonly z.infer<typeof block>[] | undefined): {
  output: string
  images: number
} {
  if (content === undefined) return { output: '', images: 0 }
  if (typeof content === 'string') return { output: content, images: 0 }
  const texts = content.flatMap((part) => {
    const text = textBlock.safeParse(part)
    return text.success ? [text.data.text] : []
  })
  return { output: texts.join('\n'), images: content.filter((part) => part.type === 'image').length }
}

function userBlocks(content: string | readonly z.infer<typeof block>[]): UserBlock[] {
  if (typeof content === 'string') return [{ kind: UserBlockKind.Text, text: content }]
  return content.flatMap((raw): UserBlock[] => {
    switch (raw.type) {
      case 'text': {
        const text = textBlock.safeParse(raw)
        return text.success ? [{ kind: UserBlockKind.Text, text: text.data.text }] : []
      }
      case 'image':
        return [{ kind: UserBlockKind.Image }]
      case 'tool_result': {
        const result = toolResultBlock.safeParse(raw)
        if (!result.success) return []
        const { output, images } = resultContent(result.data.content)
        return [
          {
            kind: UserBlockKind.ToolResult,
            toolUseId: result.data.tool_use_id,
            output,
            isError: result.data.is_error === true,
            images,
          },
        ]
      }
      default:
        return []
    }
  })
}

function assistantBlocks(content: readonly z.infer<typeof block>[]): AssistantBlock[] {
  return content.flatMap((raw): AssistantBlock[] => {
    switch (raw.type) {
      case 'text': {
        const text = textBlock.safeParse(raw)
        return text.success ? [{ kind: AssistantBlockKind.Text, text: text.data.text }] : []
      }
      case 'tool_use': {
        const call = toolUseBlock.safeParse(raw)
        if (!call.success) return []
        const { id, name, input } = call.data
        return [{ kind: AssistantBlockKind.ToolUse, toolUseId: id, name, input }]
      }
      default:
        return []
    }
  })
}

function fromLine(parsed: z.infer<typeof line>): TranscriptEntry {
  switch (parsed.type) {
    case 'user':
      return {
        kind: TranscriptEntryKind.User,
        ...conversationFields(parsed),
        meta: parsed.isMeta === true,
        compactSummary: parsed.isCompactSummary === true,
        blocks: userBlocks(parsed.message.content),
      }
    case 'assistant':
      return {
        kind: TranscriptEntryKind.Assistant,
        ...conversationFields(parsed),
        model: parsed.message.model ?? null,
        blocks: assistantBlocks(parsed.message.content),
      }
    case 'system': {
      const metadata = parsed.compactMetadata
      return {
        kind: TranscriptEntryKind.Compaction,
        at: parsed.timestamp,
        cwd: parsed.cwd ?? null,
        sidechain: parsed.isSidechain === true,
        trigger: metadata?.trigger ?? CompactionTrigger.Auto,
        preTokens: metadata?.preTokens ?? null,
        postTokens: metadata?.postTokens ?? null,
      }
    }
    case 'ai-title':
      return { kind: TranscriptEntryKind.AiTitle, title: parsed.aiTitle }
    case 'custom-title':
      return { kind: TranscriptEntryKind.CustomTitle, title: parsed.customTitle }
    case 'summary':
      return { kind: TranscriptEntryKind.Summary, title: parsed.summary }
  }
}

/** One transcript line as an entry Glade uses, or null for one it skips: not JSON, or not an entry it knows. */
export function parseTranscriptLine(text: string): TranscriptEntry | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = line.safeParse(json)
  return parsed.success ? fromLine(parsed.data) : null
}
