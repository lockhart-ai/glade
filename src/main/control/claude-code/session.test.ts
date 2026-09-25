import { describe, expect, it } from 'vitest'
import { CompactionTrigger } from '../../../shared/domain'
import { parseTranscriptLine } from './entries'
import { IMAGE_ONLY_PROMPT, SessionLogKind, SessionReader, type ClaudeCodeTranscript } from './session'
import { ms, plainChat, TRANSCRIPT_MODEL, TranscriptBuilder } from './test-transcripts'

const CWD = '/code/acme-api'
const FALLBACK = 1_700_000_000_000

/** Reads a builder's lines (and any raw text lines) as `readTranscript` reads a file's. */
function read(builder: TranscriptBuilder, extraLines: readonly string[] = []): ClaudeCodeTranscript {
  const reader = new SessionReader(FALLBACK)
  for (const line of [...builder.lines.map((entry) => JSON.stringify(entry)), ...extraLines]) {
    const entry = parseTranscriptLine(line)
    if (entry === null) reader.skipLine()
    else reader.add(entry)
  }
  return reader.finish()
}

describe('SessionReader', () => {
  it('reads a plain chat: a turn per prompt, each with its reply', () => {
    const session = read(plainChat(CWD))
    expect(session).toEqual({
      cwd: CWD,
      title: null,
      firstPrompt: 'Why do the rate limit tests fail on CI?',
      model: TRANSCRIPT_MODEL,
      startedAt: ms(0),
      lastActivityAt: ms(70),
      turns: [
        {
          number: 1,
          prompt: { text: 'Why do the rate limit tests fail on CI?', at: ms(0) },
          log: [],
          reply: { text: 'They assume the clock is in UTC; CI runs in another zone.', at: ms(5) },
        },
        {
          number: 2,
          prompt: { text: 'Thanks. How would you fix it?', at: ms(60) },
          log: [],
          reply: { text: 'Pin the zone in the test setup.', at: ms(70) },
        },
      ],
      messages: 4,
      skipped: { lines: 0, images: 0 },
    })
  })

  it('logs tool calls with their results: done, failed, and interrupted when there is none', () => {
    const session = read(
      new TranscriptBuilder(CWD)
        .prompt(0, 'Run the tests, then the linter.')
        .toolUse(1, 'toolu_1', 'Bash', { command: 'npm test' })
        .toolUse(2, 'toolu_2', 'Bash', { command: 'npm run lint' })
        .toolResult(4, 'toolu_2', 'src/rate.ts: 1 problem', true)
        .toolResult(3, 'toolu_1', '12 passed')
        .toolResult(5, 'toolu_unknown', 'nobody asked')
        .toolUse(6, 'toolu_3', 'Bash', { command: 'npm run build' })
        .prompt(20, '[Request interrupted by user for tool use]')
        .prompt(21, 'Stop there.')
        .say(22, 'Stopped.'),
    )
    expect(session.turns[0]?.log).toEqual([
      {
        kind: SessionLogKind.ToolCall,
        toolUseId: 'toolu_1',
        name: 'Bash',
        input: { command: 'npm test' },
        at: ms(1),
        result: { output: '12 passed', isError: false, at: ms(3) },
      },
      {
        kind: SessionLogKind.ToolCall,
        toolUseId: 'toolu_2',
        name: 'Bash',
        input: { command: 'npm run lint' },
        at: ms(2),
        result: { output: 'src/rate.ts: 1 problem', isError: true, at: ms(4) },
      },
      {
        kind: SessionLogKind.ToolCall,
        toolUseId: 'toolu_3',
        name: 'Bash',
        input: { command: 'npm run build' },
        at: ms(6),
        result: null,
      },
    ])
    expect(session.turns[0]?.reply).toBeNull()
    // The interruption marker isn't a prompt: your next message is.
    expect(session.turns.map((turn) => turn.prompt?.text)).toEqual(['Run the tests, then the linter.', 'Stop there.'])
    expect(session.messages).toBe(3)
  })

  it("makes the agent's text before a tool call narration, and its last text the reply", () => {
    const session = read(
      new TranscriptBuilder(CWD)
        .prompt(0, 'Fix the flaky test.')
        .say(1, "I'll look at the test first.")
        .say(2, 'It uses the wall clock.  ')
        .toolUse(3, 'toolu_1', 'Read', { file_path: '/code/acme-api/test/rate.test.ts' })
        .toolResult(4, 'toolu_1', 'import …')
        .thinking(5)
        .say(6, '   ')
        .toolUse(7, 'toolu_2', 'Edit', {
          file_path: '/code/acme-api/test/rate.test.ts',
          old_string: 'Date.now()',
          new_string: 'clock.now()',
        })
        .toolResult(8, 'toolu_2', 'Edited.')
        .say(9, 'Fixed it.')
        .say(10, 'It now uses a fake clock.'),
    )
    const [turn] = session.turns
    expect(turn?.log.map((entry) => entry.kind)).toEqual([
      SessionLogKind.Narration,
      SessionLogKind.ToolCall,
      SessionLogKind.ToolCall,
    ])
    expect(turn?.log[0]).toEqual({
      kind: SessionLogKind.Narration,
      text: "I'll look at the test first.\n\nIt uses the wall clock.",
      at: ms(1),
    })
    expect(turn?.reply).toEqual({ text: 'Fixed it.\n\nIt now uses a fake clock.', at: ms(10) })
  })

  it('logs a compaction in its turn, and leaves out the summary it carries on from', () => {
    const session = read(
      new TranscriptBuilder(CWD)
        .prompt(0, 'Keep going with the migration.')
        .say(1, 'Working on it.')
        .compaction(2, 'auto', 167_000)
        .toolUse(3, 'toolu_1', 'Bash', { command: 'npm run migrate' })
        .toolResult(4, 'toolu_1', 'Migrated.')
        .say(5, 'Done.')
        .prompt(10, '<command-name>/compact</command-name>\n<command-message>compact</command-message>')
        .compaction(11, 'manual', 90_000),
    )
    expect(session.turns).toHaveLength(1)
    // The text said before the compaction is narration from before it, though a tool call after it made it so.
    expect(session.turns[0]?.log).toEqual([
      { kind: SessionLogKind.Narration, text: 'Working on it.', at: ms(1) },
      {
        kind: SessionLogKind.Compaction,
        trigger: CompactionTrigger.Auto,
        preTokens: 167_000,
        postTokens: null,
        at: ms(2),
      },
      expect.objectContaining({ kind: SessionLogKind.ToolCall, toolUseId: 'toolu_1' }),
      {
        kind: SessionLogKind.Compaction,
        trigger: CompactionTrigger.Manual,
        preTokens: 90_000,
        postTokens: null,
        at: ms(11),
      },
    ])
    expect(session.turns[0]?.reply).toEqual({ text: 'Done.', at: ms(5) })
  })

  it("leaves out subagents' entries, meta messages, slash commands and their output", () => {
    const session = read(
      new TranscriptBuilder(CWD)
        .prompt(0, 'Caveat: the messages below were generated by the user while running local commands.', {
          isMeta: true,
        })
        .prompt(0, '<command-name>/model</command-name>')
        .prompt(1, '<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>')
        .prompt(2, '<bash-input>git status</bash-input>')
        .prompt(3, 'Find the flaky tests.')
        .toolUse(4, 'toolu_agent', 'Agent', { description: 'Find flaky tests', prompt: 'Look in test/' })
        .prompt(5, 'Look in test/', { isSidechain: true })
        .toolUse(6, 'toolu_sub', 'Bash', { command: 'grep -r sleep test' }, { isSidechain: true })
        .toolResult(7, 'toolu_sub', 'test/rate.test.ts', false, { isSidechain: true })
        .say(8, 'Found one.', { isSidechain: true })
        .toolResult(9, 'toolu_agent', 'Found one: test/rate.test.ts')
        .say(10, 'The flaky test is test/rate.test.ts.'),
    )
    expect(session.firstPrompt).toBe('Find the flaky tests.')
    expect(session.turns).toEqual([
      {
        number: 1,
        prompt: { text: 'Find the flaky tests.', at: ms(3) },
        log: [
          {
            kind: SessionLogKind.ToolCall,
            toolUseId: 'toolu_agent',
            name: 'Agent',
            input: { description: 'Find flaky tests', prompt: 'Look in test/' },
            at: ms(4),
            result: { output: 'Found one: test/rate.test.ts', isError: false, at: ms(9) },
          },
        ],
        reply: { text: 'The flaky test is test/rate.test.ts.', at: ms(10) },
      },
    ])
    // A subagent's entry says nothing about the session's times either.
    expect(session.lastActivityAt).toBe(ms(10))
  })

  it('counts images, and keeps a prompt that was only images', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }
    const session = read(
      new TranscriptBuilder(CWD)
        .prompt(0, [{ type: 'text', text: 'What does this chart show? [Image #1]' }, image])
        .toolUse(1, 'toolu_1', 'Read', { file_path: '/code/acme-api/docs/chart.png' })
        .toolResult(2, 'toolu_1', [image])
        .say(3, 'Latency by endpoint.')
        .prompt(4, [image, image])
        .say(5, 'Two more charts.'),
    )
    expect(session.skipped.images).toBe(4)
    expect(session.turns.map((turn) => turn.prompt?.text)).toEqual([
      'What does this chart show? [Image #1]',
      IMAGE_ONLY_PROMPT,
    ])
    expect(session.turns[0]?.log[0]).toMatchObject({ result: { output: '' } })
  })

  it('takes your title first, then the latest AI title, then a summary, else none', () => {
    const titled = (build: (builder: TranscriptBuilder) => TranscriptBuilder): string | null =>
      read(build(plainChat(CWD))).title
    expect(titled((b) => b)).toBeNull()
    expect(titled((b) => b.summary('Rate limit tests'))).toBe('Rate limit tests')
    expect(titled((b) => b.summary('Rate limit tests').aiTitle('Fix CI timezone').aiTitle('Pin the test zone'))).toBe(
      'Pin the test zone',
    )
    expect(titled((b) => b.customTitle('CI zones').aiTitle('Pin the test zone').summary('Old'))).toBe('CI zones')
  })

  it('skips and counts lines it does not know, and reads the rest', () => {
    const session = read(
      plainChat(CWD)
        .noise(80)
        .raw({ type: 'user', message: { content: 7 } }),
      ['not json at all', '{"type":"assistant","message":{"content":[{"type":"text","text":"cut o'],
    )
    expect(session.skipped.lines).toBe(5)
    expect(session.messages).toBe(4)
  })

  it('opens a turn with no prompt for what the agent does before your first', () => {
    const session = read(new TranscriptBuilder(CWD).say(1, 'Resuming.').prompt(2, 'Carry on.').say(3, 'OK.'))
    expect(session.turns.map((turn) => [turn.prompt?.text ?? null, turn.reply?.text ?? null])).toEqual([
      [null, 'Resuming.'],
      ['Carry on.', 'OK.'],
    ])
    expect(session.firstPrompt).toBe('Carry on.')
    expect(session.messages).toBe(3)
  })

  it("keeps the last model the agent ran on, not Claude Code's own stand-in replies", () => {
    const session = read(
      plainChat(CWD).say(80, 'API Error: 529', {
        message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529' }] },
      }),
    )
    expect(session.model).toBe(TRANSCRIPT_MODEL)
  })

  it('times entries that say no time by the one before, and by the fallback before any', () => {
    const session = read(
      new TranscriptBuilder(CWD)
        .raw({ type: 'user', cwd: CWD, message: { content: 'First.' } })
        .say(5, 'Reply.')
        .raw({ type: 'user', cwd: '/elsewhere', message: { content: 'Second.' } }),
    )
    expect(session.startedAt).toBe(FALLBACK)
    expect(session.turns.map((turn) => turn.prompt?.at)).toEqual([FALLBACK, ms(5)])
    // The folder is the first one an entry names.
    expect(session.cwd).toBe(CWD)
    // A clock set back doesn't move the last activity back.
    expect(read(plainChat(CWD).say(1, 'Late.')).lastActivityAt).toBe(ms(70))
  })

  it('reads an empty transcript as a session with nothing in it', () => {
    expect(read(new TranscriptBuilder(CWD))).toEqual({
      cwd: null,
      title: null,
      firstPrompt: null,
      model: null,
      startedAt: FALLBACK,
      lastActivityAt: FALLBACK,
      turns: [],
      messages: 0,
      skipped: { lines: 0, images: 0 },
    })
  })
})
