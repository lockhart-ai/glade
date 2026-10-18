import { expect, it } from 'vitest'
import { AGENTS_TOOL_SIGNATURES } from './managed-backend'
import { toolFingerprint } from './tool-fingerprint'

it('has a signature for each of the glade-agents tools, named and described as the server defines them', () => {
  expect(AGENTS_TOOL_SIGNATURES.map(({ name }) => name)).toEqual(['list_models', 'dispatch', 'message_child'])
  for (const signature of AGENTS_TOOL_SIGNATURES) {
    expect(signature.description.length).toBeGreaterThan(0)
    expect(signature.inputSchema).toMatchObject({ type: 'object' })
  }
})

it("gives dispatch's signature a different fingerprint from message_child's, the same one for itself twice", () => {
  const [, dispatch, messageChild] = AGENTS_TOOL_SIGNATURES
  if (dispatch === undefined || messageChild === undefined) throw new Error('missing a signature')

  expect(toolFingerprint(dispatch)).not.toBe(toolFingerprint(messageChild))
  expect(toolFingerprint(dispatch)).toBe(toolFingerprint({ ...dispatch }))
})
