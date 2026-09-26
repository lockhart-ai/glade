import { describe, expect, it } from 'vitest'
import type { TaskHandoff } from '../../shared/domain'
import type { SessionContext } from '../db/repositories/session-context'
import {
  contextAfter,
  contextBlock,
  missingContext,
  MissingContextKind,
  startedContext,
  withContext,
  type ContextCheck,
  type MissingContext,
} from './session-context'
import { FINAL_REPLY_LINE, handoffSection, INSTRUCTION_UPDATES } from './system-prompt'

const HANDOFF: TaskHandoff = { taskId: 't1', body: '## Next\n\nShip it.', addedAt: 5_000 }
const PROMPT = 'You are running inside Glade.'
const CURRENT = INSTRUCTION_UPDATES.length

function check(overrides: Partial<ContextCheck>): ContextCheck {
  return { recorded: undefined, startedElsewhere: false, handoff: null, prompt: PROMPT, ...overrides }
}

/** What's recorded for a session that has Glade's prompt, `updates` of the instructions added since, and a note. */
function has(updates: number, handoffAt: number | null = null): SessionContext {
  return { instructions: true, instructionUpdates: updates, handoffAt }
}

describe('what a session is missing', () => {
  it('is nothing for a session Glade starts, until a handoff note it has not had', () => {
    expect(missingContext(check({ recorded: startedContext(null) }))).toEqual([])
    expect(missingContext(check({ recorded: startedContext(HANDOFF), handoff: HANDOFF }))).toEqual([])
    expect(startedContext(HANDOFF)).toEqual(has(CURRENT, 5_000))

    expect(missingContext(check({ recorded: has(CURRENT, 1_000), handoff: HANDOFF }))).toEqual([
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
    expect(missingContext(check({ recorded: has(CURRENT), handoff: HANDOFF }))).toEqual([
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
  })

  it('is the instructions added since, for a session that started before them', () => {
    const updates = { kind: MissingContextKind.Updates, updates: [FINAL_REPLY_LINE] }

    expect(missingContext(check({ recorded: has(0) }))).toEqual([updates])
    // One Glade started before anything was recorded had its prompt, but none of the instructions added since.
    expect(missingContext(check({}))).toEqual([updates])
    // Only the ones it hasn't had: a session past the last has none to get.
    expect(missingContext(check({ recorded: has(CURRENT) }))).toEqual([])
    expect(missingContext(check({ recorded: has(CURRENT + 3) }))).toEqual([])
  })

  it('is the instructions added since, then the handoff note, when it is missing both', () => {
    expect(missingContext(check({ handoff: HANDOFF }))).toEqual([
      { kind: MissingContextKind.Updates, updates: [FINAL_REPLY_LINE] },
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
    expect(missingContext(check({ recorded: has(0, 5_000), handoff: HANDOFF }))).toEqual([
      { kind: MissingContextKind.Updates, updates: [FINAL_REPLY_LINE] },
    ])
  })

  it("is Glade's whole prompt, handoff note, new instructions and all, for a session that started elsewhere", () => {
    expect(missingContext(check({ startedElsewhere: true, handoff: HANDOFF }))).toEqual([
      { kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: 5_000 },
    ])
    expect(missingContext(check({ startedElsewhere: true }))).toEqual([
      { kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: null },
    ])
    // Once sent, what's recorded says so, whatever it started with.
    expect(missingContext(check({ startedElsewhere: true, recorded: has(CURRENT) }))).toEqual([])
    expect(
      missingContext(check({ recorded: { instructions: false, instructionUpdates: 0, handoffAt: null } })),
    ).toMatchObject([{ kind: MissingContextKind.Instructions }])
  })
})

describe('sending what a session is missing', () => {
  const handoff = { kind: MissingContextKind.Handoff, handoff: HANDOFF } as const
  const instructions = { kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: 5_000 } as const
  const updates = { kind: MissingContextKind.Updates, updates: [FINAL_REPLY_LINE] } as const

  it('records it as given, keeping what the session already had', () => {
    const stale = check({ recorded: has(0, 1_000), handoff: HANDOFF })

    expect(contextAfter(stale, [handoff])).toEqual(has(0, 5_000))
    expect(contextAfter(stale, [updates])).toEqual(has(CURRENT, 1_000))
    expect(contextAfter(stale, [updates, handoff])).toEqual(has(CURRENT, 5_000))
    expect(contextAfter(check({ startedElsewhere: true }), [instructions])).toEqual(has(CURRENT, 5_000))
    // A note cleared since it was sent is left recorded as it was: nothing's sent for it.
    expect(contextAfter(check({ recorded: has(0, 1_000) }), [updates])).toEqual(has(CURRENT, 1_000))
    expect(contextAfter(check({}), [])).toEqual(has(0))
  })

  it('says each in a block ahead of the message, in order, and nothing when it misses none', () => {
    const blocks: readonly MissingContext[] = [updates, handoff]

    expect(contextBlock([handoff])).toBe(`[Glade: handoff for this task]\n${handoffSection(HANDOFF)}\n[end]`)
    expect(contextBlock([instructions])).toBe(`[Glade: instructions for this session]\n${PROMPT}\n[end]`)
    expect(contextBlock([updates])).toBe(`[Glade: new instructions for this session]\n${FINAL_REPLY_LINE}\n[end]`)
    expect(contextBlock(blocks)).toBe(`${String(contextBlock([updates]))}\n\n${String(contextBlock([handoff]))}`)
    expect(contextBlock([{ kind: MissingContextKind.Updates, updates: ['One.', 'Two.'] }])).toBe(
      '[Glade: new instructions for this session]\nOne.\n\nTwo.\n[end]',
    )
    expect(contextBlock([])).toBeNull()
    expect(withContext(contextBlock([handoff]), 'Carry on.')).toBe(`${String(contextBlock([handoff]))}\n\nCarry on.`)
    expect(withContext(null, 'Carry on.')).toBe('Carry on.')
  })
})
