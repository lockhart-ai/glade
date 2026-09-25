// Test helpers: invented Claude Code transcripts (the Acme API workspace), in the shapes `docs/sdk-notes.md` §8
// records, and a projects folder to keep them in. Never a real session.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The session most tests import. */
export const SESSION_ID = '5b2f8c1e-4d7a-4e3b-9f10-2a6c8d9e0f11'

/** The model the invented agent runs on, as the API names it. */
export const TRANSCRIPT_MODEL = 'claude-haiku-4-5-20251001'

/** A transcript line: one JSON object. */
export type TranscriptLine = Readonly<Record<string, unknown>>

/** An ISO timestamp `seconds` after 10:00 UTC on a made-up day. */
export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, seconds)).toISOString()
}

/** The epoch milliseconds of `at(seconds)`. */
export function ms(seconds: number): number {
  return Date.parse(at(seconds))
}

/** What every conversation line carries, overridable. */
function common(seconds: number, timestamp: string, cwd: string, extra: TranscriptLine): TranscriptLine {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: SESSION_ID,
    version: '2.1.281',
    gitBranch: 'main',
    uuid: `uuid-${String(seconds)}`,
    timestamp,
    ...extra,
  }
}

/** Builds the lines of one session, all in the folder `cwd`. */
export class TranscriptBuilder {
  readonly lines: TranscriptLine[] = []

  /** @param start When its second 0 is: 10:00 UTC on a made-up day (`at(0)`) by default. */
  constructor(
    readonly cwd: string,
    readonly start: number = ms(0),
  ) {}

  /** The ISO time `seconds` after the session's start. */
  private stamp(seconds: number): string {
    return new Date(this.start + seconds * 1000).toISOString()
  }

  /** Adds a line as it is. */
  raw(line: TranscriptLine): this {
    this.lines.push(line)
    return this
  }

  /** Your prompt: a string, or content blocks. */
  prompt(seconds: number, content: string | readonly TranscriptLine[], extra: TranscriptLine = {}): this {
    return this.raw(
      common(seconds, this.stamp(seconds), this.cwd, {
        type: 'user',
        message: { role: 'user', content },
        promptId: 'p',
        ...extra,
      }),
    )
  }

  /** One of the agent's content blocks, as Claude Code writes each in its own line. */
  assistant(seconds: number, block: TranscriptLine, extra: TranscriptLine = {}): this {
    return this.raw(
      common(seconds, this.stamp(seconds), this.cwd, {
        type: 'assistant',
        requestId: 'req_1',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: TRANSCRIPT_MODEL,
          content: [block],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        ...extra,
      }),
    )
  }

  say(seconds: number, text: string, extra: TranscriptLine = {}): this {
    return this.assistant(seconds, { type: 'text', text }, extra)
  }

  thinking(seconds: number): this {
    return this.assistant(seconds, { type: 'thinking', thinking: '', signature: 'c2lnbmF0dXJl' })
  }

  toolUse(seconds: number, id: string, name: string, input: TranscriptLine, extra: TranscriptLine = {}): this {
    return this.assistant(seconds, { type: 'tool_use', id, name, input, caller: { type: 'direct' } }, extra)
  }

  toolResult(
    seconds: number,
    id: string,
    content: string | readonly TranscriptLine[],
    isError = false,
    extra: TranscriptLine = {},
  ): this {
    return this.raw(
      common(seconds, this.stamp(seconds), this.cwd, {
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] },
        toolUseResult: { stdout: typeof content === 'string' ? content : '', stderr: '', interrupted: false },
        ...extra,
      }),
    )
  }

  compaction(seconds: number, trigger: string, preTokens: number): this {
    this.raw(
      common(seconds, this.stamp(seconds), this.cwd, {
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        isMeta: false,
        level: 'info',
        compactMetadata: { trigger, preTokens },
      }),
    )
    return this.prompt(seconds, 'This session is being continued from a previous conversation. Summary: …', {
      isCompactSummary: true,
    })
  }

  /** Claude Code's own lines that aren't conversation: an attachment and a queue operation. */
  noise(seconds: number): this {
    this.raw(
      common(seconds, this.stamp(seconds), this.cwd, {
        type: 'attachment',
        attachment: { type: 'date', date: '2026-09-01' },
      }),
    )
    return this.raw({
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: this.stamp(seconds),
      sessionId: SESSION_ID,
    })
  }

  aiTitle(title: string): this {
    return this.raw({ type: 'ai-title', aiTitle: title, sessionId: SESSION_ID })
  }

  customTitle(title: string): this {
    return this.raw({ type: 'custom-title', customTitle: title, sessionId: SESSION_ID })
  }

  summary(summary: string): this {
    return this.raw({ type: 'summary', summary, leafUuid: 'uuid-1' })
  }

  /** The transcript's text: one JSON object per line. */
  toJsonl(): string {
    return this.lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  }
}

/** A plain chat about the Acme API: two prompts, two replies. */
export function plainChat(cwd: string): TranscriptBuilder {
  return new TranscriptBuilder(cwd)
    .prompt(0, 'Why do the rate limit tests fail on CI?')
    .say(5, 'They assume the clock is in UTC; CI runs in another zone.')
    .prompt(60, 'Thanks. How would you fix it?')
    .say(70, 'Pin the zone in the test setup.')
}

/** The folder Claude Code keeps a session from `cwd` in: `cwd` with every non-alphanumeric character a dash. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Writes a transcript into the projects folder, where Claude Code would keep it, and answers its path. */
export function writeTranscript(
  projectsDir: string,
  cwd: string,
  text: string,
  sessionId: string = SESSION_ID,
): string {
  const folder = join(projectsDir, projectSlug(cwd))
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `${sessionId}.jsonl`)
  writeFileSync(path, text)
  return path
}
