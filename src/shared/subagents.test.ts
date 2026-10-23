import { describe, expect, it } from 'vitest'
import { isSubagentTool, subagentName, subagentPrompt, UNNAMED_SUBAGENT } from './subagents'

describe('isSubagentTool', () => {
  it('names the two native tool names and the dispatch tool, nothing else', () => {
    expect(isSubagentTool('Agent')).toBe(true)
    expect(isSubagentTool('Task')).toBe(true)
    expect(isSubagentTool('mcp__glade-agents__dispatch')).toBe(true)
    expect(isSubagentTool('Bash')).toBe(false)
  })
})

describe('subagentName', () => {
  it('prefers the description, falls back to the subagent type, else the unnamed label', () => {
    expect(subagentName({ input: { description: 'review-49', subagent_type: 'general-purpose' } })).toBe('review-49')
    expect(subagentName({ input: { subagent_type: 'general-purpose' } })).toBe('general-purpose')
    expect(subagentName({ input: {} })).toBe(UNNAMED_SUBAGENT)
  })
})

describe('subagentPrompt (#762)', () => {
  it('reads the prompt a native Agent call started a subagent with, verbatim', () => {
    expect(subagentPrompt({ input: { description: 'review-49', prompt: 'Review PR #511 for regressions.' } })).toBe(
      'Review PR #511 for regressions.',
    )
  })

  it('reads the prompt a dispatched child was started with, the same way', () => {
    expect(
      subagentPrompt({
        input: { description: 'review-49', prompt: 'Review PR #511 for regressions.', model: 'claude-haiku-4-5' },
      }),
    ).toBe('Review PR #511 for regressions.')
  })

  it('keeps a multi-line prompt exactly as given, leading and trailing whitespace included', () => {
    const prompt = '  Line one.\nLine two, with detail.\n  '
    expect(subagentPrompt({ input: { prompt } })).toBe(prompt)
  })

  it('is null for a call with no prompt field, a blank one, or one that isn’t a string', () => {
    expect(subagentPrompt({ input: {} })).toBeNull()
    expect(subagentPrompt({ input: { prompt: '' } })).toBeNull()
    expect(subagentPrompt({ input: { prompt: '   ' } })).toBeNull()
    expect(subagentPrompt({ input: { prompt: 42 } })).toBeNull()
  })
})
