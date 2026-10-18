import { expect, it } from 'vitest'
import { z } from 'zod'
import { jsonSchemaOfShape, toolFingerprint, toolFingerprints } from './tool-fingerprint'

const SIGNATURE = {
  name: 'update_todo',
  description: "Change one of this task's todos.",
  inputSchema: jsonSchemaOfShape({ id: z.string() }),
}

it("is a zod shape's input schema, as JSON Schema", () => {
  expect(jsonSchemaOfShape({ id: z.string() })).toMatchObject({
    type: 'object',
    properties: { id: { type: 'string' } },
  })
})

it('is the same for the same name, description and input schema', () => {
  expect(toolFingerprint(SIGNATURE)).toBe(toolFingerprint({ ...SIGNATURE }))
})

it('differs when the name, the description or the input schema does', () => {
  const base = toolFingerprint(SIGNATURE)
  expect(toolFingerprint({ ...SIGNATURE, name: 'create_todo' })).not.toBe(base)
  expect(toolFingerprint({ ...SIGNATURE, description: 'Something else.' })).not.toBe(base)
  expect(toolFingerprint({ ...SIGNATURE, inputSchema: jsonSchemaOfShape({ id: z.number() }) })).not.toBe(base)
})

it('is one fingerprint per tool, by name', () => {
  const other = { name: 'create_todo', description: 'Add a todo.', inputSchema: jsonSchemaOfShape({}) }

  const fingerprints = toolFingerprints([SIGNATURE, other])

  expect(fingerprints.get('update_todo')).toBe(toolFingerprint(SIGNATURE))
  expect(fingerprints.get('create_todo')).toBe(toolFingerprint(other))
  expect(fingerprints.size).toBe(2)
})
