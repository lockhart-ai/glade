import { describe, expect, it } from 'vitest'
import { CompactionTrigger } from '../../../shared/domain'
import { AssistantBlockKind, parseTranscriptLine, TranscriptEntryKind, UserBlockKind } from './entries'
import { at, ms, TRANSCRIPT_MODEL, TranscriptBuilder, type TranscriptLine } from './test-transcripts'

const CWD = '/code/acme-api'

/** The one line a builder step writes, as text. */
function lineOf(build: (builder: TranscriptBuilder) => TranscriptBuilder): string {
  const [line] = build(new TranscriptBuilder(CWD)).lines
  return JSON.stringify(line)
}

function parse(line: TranscriptLine): ReturnType<typeof parseTranscriptLine> {
  return parseTranscriptLine(JSON.stringify(line))
}

describe('parseTranscriptLine', () => {
  it('reads your prompt, as a string or as blocks', () => {
    expect(parseTranscriptLine(lineOf((b) => b.prompt(1, 'Run the tests')))).toEqual({
      kind: TranscriptEntryKind.User,
      at: ms(1),
      cwd: CWD,
      sidechain: false,
      meta: false,
      compactSummary: false,
      blocks: [{ kind: UserBlockKind.Text, text: 'Run the tests' }],
    })
    const blocks = parseTranscriptLine(
      lineOf((b) =>
        b.prompt(1, [
          { type: 'text', text: 'What is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
          { type: 'document', source: {} },
          { type: 'text', text: 42 },
        ]),
      ),
    )
    expect(blocks).toMatchObject({
      blocks: [{ kind: UserBlockKind.Text, text: 'What is this?' }, { kind: UserBlockKind.Image }],
    })
  })

  it('reads meta, compact summary and sidechain flags', () => {
    expect(parseTranscriptLine(lineOf((b) => b.prompt(1, 'Caveat', { isMeta: true })))).toMatchObject({ meta: true })
    expect(parseTranscriptLine(lineOf((b) => b.prompt(1, 'Summary', { isCompactSummary: true })))).toMatchObject({
      compactSummary: true,
    })
    expect(parseTranscriptLine(lineOf((b) => b.prompt(1, 'Find it', { isSidechain: true })))).toMatchObject({
      sidechain: true,
    })
    // A flag of the wrong type is as good as missing.
    expect(parseTranscriptLine(lineOf((b) => b.prompt(1, 'Hi', { isMeta: 'yes', isSidechain: 1 })))).toMatchObject({
      meta: false,
      sidechain: false,
    })
  })

  it('reads tool results: text, blocks, errors, images', () => {
    expect(parseTranscriptLine(lineOf((b) => b.toolResult(2, 'toolu_1', '12 passed')))).toMatchObject({
      blocks: [
        { kind: UserBlockKind.ToolResult, toolUseId: 'toolu_1', output: '12 passed', isError: false, images: 0 },
      ],
    })
    expect(
      parseTranscriptLine(
        lineOf((b) =>
          b.toolResult(
            2,
            'toolu_2',
            [
              { type: 'text', text: 'Line one' },
              { type: 'image', source: {} },
              { type: 'text', text: 'Line two' },
            ],
            true,
          ),
        ),
      ),
    ).toMatchObject({
      blocks: [
        {
          kind: UserBlockKind.ToolResult,
          toolUseId: 'toolu_2',
          output: 'Line one\nLine two',
          isError: true,
          images: 1,
        },
      ],
    })
    // No content at all, or content Glade can't read, is an empty result; a result without an id is dropped.
    expect(
      parse({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_3' },
            { type: 'tool_result', tool_use_id: 'toolu_4', content: 7 },
            { type: 'tool_result', content: 'orphan' },
          ],
        },
      }),
    ).toMatchObject({
      blocks: [
        { kind: UserBlockKind.ToolResult, toolUseId: 'toolu_3', output: '' },
        { kind: UserBlockKind.ToolResult, toolUseId: 'toolu_4', output: '' },
      ],
    })
  })

  it("reads the agent's text and tool calls, and leaves out thinking", () => {
    expect(parseTranscriptLine(lineOf((b) => b.say(3, 'Done.')))).toEqual({
      kind: TranscriptEntryKind.Assistant,
      at: ms(3),
      cwd: CWD,
      sidechain: false,
      model: TRANSCRIPT_MODEL,
      blocks: [{ kind: AssistantBlockKind.Text, text: 'Done.' }],
    })
    expect(parseTranscriptLine(lineOf((b) => b.toolUse(3, 'toolu_1', 'Bash', { command: 'npm test' })))).toMatchObject({
      blocks: [
        { kind: AssistantBlockKind.ToolUse, toolUseId: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ],
    })
    expect(parseTranscriptLine(lineOf((b) => b.thinking(3)))).toMatchObject({ blocks: [] })
    // Malformed blocks are dropped one at a time, and a missing model is null.
    expect(
      parse({
        type: 'assistant',
        message: {
          content: [
            { type: 'text' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: 'npm test' },
            { type: 'text', text: 'Still here.' },
          ],
        },
      }),
    ).toEqual({
      kind: TranscriptEntryKind.Assistant,
      at: null,
      cwd: null,
      sidechain: false,
      model: null,
      blocks: [{ kind: AssistantBlockKind.Text, text: 'Still here.' }],
    })
  })

  it('reads compactions, with or without their metadata', () => {
    const [boundary] = new TranscriptBuilder(CWD).compaction(9, 'manual', 150_000).lines
    expect(parse(boundary ?? {})).toEqual({
      kind: TranscriptEntryKind.Compaction,
      at: ms(9),
      cwd: CWD,
      sidechain: false,
      trigger: CompactionTrigger.Manual,
      preTokens: 150_000,
      postTokens: null,
    })
    expect(
      parse({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', postTokens: 30_000 } }),
    ).toMatchObject({ trigger: CompactionTrigger.Auto, preTokens: null, postTokens: 30_000 })
    expect(
      parse({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'sometimes', preTokens: -1 } }),
    ).toMatchObject({ trigger: CompactionTrigger.Auto, preTokens: null })
    expect(parse({ type: 'system', subtype: 'compact_boundary', isSidechain: true })).toMatchObject({
      sidechain: true,
      preTokens: null,
    })
  })

  it('reads the three kinds of title', () => {
    expect(parse({ type: 'ai-title', aiTitle: 'Fix the flaky date test' })).toEqual({
      kind: TranscriptEntryKind.AiTitle,
      title: 'Fix the flaky date test',
    })
    expect(parse({ type: 'custom-title', customTitle: 'Date bug' })).toEqual({
      kind: TranscriptEntryKind.CustomTitle,
      title: 'Date bug',
    })
    expect(parse({ type: 'summary', summary: 'Fixed the timezone bug' })).toEqual({
      kind: TranscriptEntryKind.Summary,
      title: 'Fixed the timezone bug',
    })
  })

  it('ignores fields it does not know, and reads a timestamp it cannot as none', () => {
    expect(parse({ type: 'ai-title', aiTitle: 'Rate limits', somethingNew: { nested: true } })).toMatchObject({
      title: 'Rate limits',
    })
    expect(parse({ type: 'user', timestamp: 'yesterday', message: { content: 'Hi' } })).toMatchObject({ at: null })
    expect(parse({ type: 'user', timestamp: 17, cwd: 3, message: { content: 'Hi' } })).toMatchObject({
      at: null,
      cwd: null,
    })
    expect(parse({ type: 'user', timestamp: at(4), message: { content: 'Hi' } })).toMatchObject({ at: ms(4) })
  })

  it('skips lines that are not JSON, not objects, or not an entry it knows', () => {
    for (const line of [
      '',
      'not json',
      '{"type":"user","message":{"content":"cut off mid',
      '42',
      'null',
      '[]',
      JSON.stringify({ type: 'attachment', attachment: { type: 'date' } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      JSON.stringify({ type: 'system', subtype: 'api_error' }),
      JSON.stringify({ type: 'user' }),
      JSON.stringify({ type: 'user', message: { content: 7 } }),
      JSON.stringify({ type: 'assistant', message: { content: 'text' } }),
      JSON.stringify({ type: 'ai-title' }),
      JSON.stringify({ aiTitle: 'No type' }),
    ]) {
      expect(parseTranscriptLine(line), line).toBeNull()
    }
  })
})
