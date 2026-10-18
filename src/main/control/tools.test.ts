import { expect, it } from 'vitest'
import { toolFingerprint } from '../agent/tool-fingerprint'
import { CONTROL_TOOL_SIGNATURES, CONTROL_TOOLS } from './tools'

it('fingerprints every glade-control tool, from the same name, description and input schema the server serves (#709)', () => {
  expect(CONTROL_TOOL_SIGNATURES).toHaveLength(CONTROL_TOOLS.length)
  for (const [index, tool] of CONTROL_TOOLS.entries()) {
    expect(CONTROL_TOOL_SIGNATURES[index]).toEqual({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })
  }
})

it('gives a different fingerprint for two tools whose description or schema differ, the same for one unchanged', () => {
  const [first, second] = CONTROL_TOOL_SIGNATURES
  if (first === undefined || second === undefined) throw new Error('CONTROL_TOOL_SIGNATURES needs at least two tools')

  expect(toolFingerprint(first)).not.toBe(toolFingerprint(second))
  expect(toolFingerprint(first)).toBe(toolFingerprint({ ...first }))
})
