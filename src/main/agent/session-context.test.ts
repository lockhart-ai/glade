import { describe, expect, it } from 'vitest'
import type { TaskHandoff } from '../../shared/domain'
import {
  contextAfter,
  contextBlock,
  missingContext,
  MissingContextKind,
  startedContext,
  withContext,
  type ContextCheck,
} from './session-context'
import { handoffSection } from './system-prompt'

const HANDOFF: TaskHandoff = { taskId: 't1', body: '## Next\n\nShip it.', addedAt: 5_000 }
const PROMPT = 'You are running inside Glade.'

function check(overrides: Partial<ContextCheck>): ContextCheck {
  return { recorded: undefined, startedElsewhere: false, handoff: null, prompt: PROMPT, ...overrides }
}

describe('what a session is missing', () => {
  it('is nothing for a session Glade started, until a handoff note it has not had', () => {
    expect(missingContext(check({}))).toBeNull()
    expect(missingContext(check({ recorded: startedContext(null) }))).toBeNull()
    expect(missingContext(check({ recorded: startedContext(HANDOFF), handoff: HANDOFF }))).toBeNull()

    expect(missingContext(check({ handoff: HANDOFF }))).toEqual({ kind: MissingContextKind.Handoff, handoff: HANDOFF })
    expect(missingContext(check({ recorded: { instructions: true, handoffAt: 1_000 }, handoff: HANDOFF }))).toEqual({
      kind: MissingContextKind.Handoff,
      handoff: HANDOFF,
    })
  })

  it("is Glade's whole prompt, handoff note and all, for a session that started elsewhere", () => {
    const missing = missingContext(check({ startedElsewhere: true, handoff: HANDOFF }))

    expect(missing).toEqual({ kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: 5_000 })
    expect(missingContext(check({ startedElsewhere: true }))).toEqual({
      kind: MissingContextKind.Instructions,
      prompt: PROMPT,
      handoffAt: null,
    })
    // Once sent, what's recorded says so, whatever it started with.
    expect(
      missingContext(check({ startedElsewhere: true, recorded: { instructions: true, handoffAt: null } })),
    ).toBeNull()
    expect(missingContext(check({ recorded: { instructions: false, handoffAt: null } }))).toMatchObject({
      kind: MissingContextKind.Instructions,
    })
  })
})

describe('sending what a session is missing', () => {
  it('records it as given, and says it in a block ahead of the message', () => {
    const handoff = { kind: MissingContextKind.Handoff, handoff: HANDOFF } as const
    const instructions = { kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: 5_000 } as const

    expect(contextAfter(handoff)).toEqual({ instructions: true, handoffAt: 5_000 })
    expect(contextAfter(instructions)).toEqual({ instructions: true, handoffAt: 5_000 })
    expect(contextBlock(handoff)).toBe(`[Glade: handoff for this task]\n${handoffSection(HANDOFF)}\n[end]`)
    expect(contextBlock(instructions)).toBe(`[Glade: instructions for this session]\n${PROMPT}\n[end]`)
    expect(withContext(contextBlock(handoff), 'Carry on.')).toBe(`${contextBlock(handoff)}\n\nCarry on.`)
    expect(withContext(null, 'Carry on.')).toBe('Carry on.')
  })
})
