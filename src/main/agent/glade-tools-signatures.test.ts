import { expect, it } from 'vitest'
import { toolFingerprint } from './tool-fingerprint'
import { DESCRIPTIONS, GLADE_TOOL_SIGNATURES, GladeTool } from './glade-tools'

it('has a signature for every GladeTool, named and described as the server defines it', () => {
  expect(GLADE_TOOL_SIGNATURES).toHaveLength(Object.values(GladeTool).length)
  for (const tool of Object.values(GladeTool)) {
    const name: string = tool
    const signature = GLADE_TOOL_SIGNATURES.find((candidate) => candidate.name === name)
    expect(signature).toBeDefined()
    expect(signature?.description).toBe(DESCRIPTIONS[tool])
    expect(signature?.inputSchema).toMatchObject({ type: 'object' })
  }
})

it("gives update_todo's signature a different fingerprint from create_todo's, the same one for itself twice", () => {
  const updateTodoName: string = GladeTool.UpdateTodo
  const createTodoName: string = GladeTool.CreateTodo
  const updateTodo = GLADE_TOOL_SIGNATURES.find(({ name }) => name === updateTodoName)
  const createTodo = GLADE_TOOL_SIGNATURES.find(({ name }) => name === createTodoName)
  if (updateTodo === undefined || createTodo === undefined) throw new Error('missing a signature')

  expect(toolFingerprint(updateTodo)).not.toBe(toolFingerprint(createTodo))
  expect(toolFingerprint(updateTodo)).toBe(toolFingerprint({ ...updateTodo }))
})
