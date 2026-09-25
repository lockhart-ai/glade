import { describe, expect, it } from 'vitest'
import { ToolCallState, ToolEventKind, type ToolCallEvent } from '../../shared/domain'
import { MAX_PLUGIN_TEXT } from '../../shared/plugin-api'
import { cutText, latestLine, pluginSubagent, toolSummary, UNNAMED_SUBAGENT } from './mapping'

function agentCall(input: ToolCallEvent['input']): ToolCallEvent {
  return {
    kind: ToolEventKind.ToolCall,
    id: 'event-1',
    taskId: 'task-1',
    turn: 1,
    createdAt: 1,
    name: 'Agent',
    input,
    output: null,
    state: ToolCallState.Running,
    finishedAt: null,
    toolUseId: 'toolu_1',
    parentToolUseId: null,
  }
}

describe('cutText', () => {
  it('leaves text up to the limit alone', () => {
    expect(cutText('x'.repeat(MAX_PLUGIN_TEXT))).toBe('x'.repeat(MAX_PLUGIN_TEXT))
  })

  it('cuts longer text to the limit, never through a character made of two code units', () => {
    expect(cutText('x'.repeat(MAX_PLUGIN_TEXT + 1))).toBe('x'.repeat(MAX_PLUGIN_TEXT))
    expect(cutText(`${'x'.repeat(MAX_PLUGIN_TEXT - 1)}😺`)).toBe('x'.repeat(MAX_PLUGIN_TEXT - 1))
    expect(cutText(`${'x'.repeat(MAX_PLUGIN_TEXT - 2)}😺😺`)).toBe(`${'x'.repeat(MAX_PLUGIN_TEXT - 2)}😺`)
  })
})

describe('toolSummary', () => {
  it('makes a file inside the workspace relative to it, and leaves one outside it, or with no workspace, as it is', () => {
    expect(toolSummary('Read', { file_path: '/code/acme-api/src/a.ts' }, '/code/acme-api')).toBe('src/a.ts')
    expect(toolSummary('Read', { file_path: '/code/other/a.ts' }, '/code/acme-api')).toBe('/code/other/a.ts')
    expect(toolSummary('Read', { file_path: '/code/acme-api/src/a.ts' }, undefined)).toBe('/code/acme-api/src/a.ts')
  })

  it("gives nothing for a field that isn't text, or a tool it doesn't know", () => {
    expect(toolSummary('Read', { file_path: 42 }, undefined)).toBe('')
    expect(toolSummary('Anything', { text: 'Private' }, undefined)).toBe('')
  })
})

describe('pluginSubagent', () => {
  it('names a subagent by its description, else its type, else as the Subagents tab does', () => {
    expect(pluginSubagent(agentCall({ description: ' Sort the PRs ' }), null).name).toBe('Sort the PRs')
    expect(pluginSubagent(agentCall({ description: '  ', subagent_type: 'Explore' }), null).name).toBe('Explore')
    expect(pluginSubagent(agentCall({ prompt: 'Private' }), null).name).toBe(UNNAMED_SUBAGENT)
  })
})

describe('latestLine', () => {
  it('is a call with no summary as its tool alone', () => {
    expect(latestLine({ ...agentCall({}), name: 'mcp__glade__set_status' }, undefined)).toBe('set_status')
  })
})
