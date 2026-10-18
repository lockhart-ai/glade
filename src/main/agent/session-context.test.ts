import { describe, expect, it } from 'vitest'
import type { TaskHandoff } from '../../shared/domain'
import type { SessionContext } from '../db/repositories/session-context'
import { hashLines } from './instruction-hash'
import {
  contextAfter,
  contextBlock,
  missingContext,
  missingToolChanges,
  MissingContextKind,
  startedContext,
  withContext,
  type ContextCheck,
  type MissingContext,
} from './session-context'
import { toolFingerprint, type ToolSignature } from './tool-fingerprint'
import {
  FINAL_REPLY_LINE,
  GITHUB_LINK_WATCH_LINE,
  handoffSection,
  INSTRUCTION_UPDATES,
  LINK_ARTIFACTS_LINE,
  OTHER_TASKS_LINE,
  SANDBOX_LINE,
  TODO_HUB_ARTIFACTS_LINE,
  TODO_HUB_FILING_LINE,
  TODO_HUB_LINES,
  TODO_HUB_TOOLS_LINE,
  TODO_LINKS_LINE,
  TODO_TOOLS_LINE,
  USAGE_NOTES_LINE,
} from './system-prompt'

const HANDOFF: TaskHandoff = { taskId: 't1', body: '## Next\n\nShip it.', addedAt: 5_000 }
const PROMPT = 'You are running inside Glade.'
const CURRENT = INSTRUCTION_UPDATES.length

function check(overrides: Partial<ContextCheck>): ContextCheck {
  return { recorded: undefined, startedElsewhere: false, handoff: null, prompt: PROMPT, sandboxed: false, ...overrides }
}

/**
 * What's recorded for a session that has Glade's prompt, `updates` of the instructions added since (with the
 * fingerprint those lines' text has today, unless `instructionUpdateHash` says otherwise — a stale one, #708), and a
 * note. It has been told of the todo hub, as every session Glade starts has, unless said.
 */
function has(
  updates: number,
  handoffAt: number | null = null,
  sandbox = false,
  todoHub = true,
  instructionUpdateHash = hashLines(INSTRUCTION_UPDATES.slice(0, updates)),
): SessionContext {
  return { instructions: true, instructionUpdates: updates, instructionUpdateHash, handoffAt, sandbox, todoHub }
}

/** The todo hub's lines, which a session from before anything was recorded for it is missing. */
const TODO_HUB = { kind: MissingContextKind.TodoHub } as const

/** A session with everything but the todo hub: one that started before the hub was on for every task (#501). */
const BEFORE_HUB = has(CURRENT, null, false, false)

describe('what a session is missing', () => {
  it('is nothing for a session Glade starts, until a handoff note it has not had', () => {
    expect(missingContext(check({ recorded: startedContext(null, false) }))).toEqual([])
    expect(missingContext(check({ recorded: startedContext(HANDOFF, false), handoff: HANDOFF }))).toEqual([])
    expect(startedContext(HANDOFF, false)).toEqual(has(CURRENT, 5_000))

    expect(missingContext(check({ recorded: has(CURRENT, 1_000), handoff: HANDOFF }))).toEqual([
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
    expect(missingContext(check({ recorded: has(CURRENT), handoff: HANDOFF }))).toEqual([
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
  })

  it('is the instructions added since, for a session that started before them', () => {
    const updates = {
      kind: MissingContextKind.Updates,
      updates: [
        FINAL_REPLY_LINE,
        LINK_ARTIFACTS_LINE,
        OTHER_TASKS_LINE,
        TODO_TOOLS_LINE,
        USAGE_NOTES_LINE,
        TODO_LINKS_LINE,
        GITHUB_LINK_WATCH_LINE,
      ],
    }

    expect(missingContext(check({ recorded: has(0) }))).toEqual([updates])
    // One Glade started before anything was recorded had its prompt, but none of the instructions added since.
    expect(missingContext(check({}))).toEqual([updates, TODO_HUB])
    // Only the ones it hasn't had: a session past the last has none to get.
    expect(missingContext(check({ recorded: has(CURRENT) }))).toEqual([])
    expect(missingContext(check({ recorded: has(CURRENT + 3) }))).toEqual([])
  })

  it('is the instructions added since, then the handoff note, when it is missing both', () => {
    expect(missingContext(check({ handoff: HANDOFF }))).toEqual([
      {
        kind: MissingContextKind.Updates,
        updates: [
          FINAL_REPLY_LINE,
          LINK_ARTIFACTS_LINE,
          OTHER_TASKS_LINE,
          TODO_TOOLS_LINE,
          USAGE_NOTES_LINE,
          TODO_LINKS_LINE,
          GITHUB_LINK_WATCH_LINE,
        ],
      },
      TODO_HUB,
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
    expect(missingContext(check({ recorded: has(0, 5_000), handoff: HANDOFF }))).toEqual([
      {
        kind: MissingContextKind.Updates,
        updates: [
          FINAL_REPLY_LINE,
          LINK_ARTIFACTS_LINE,
          OTHER_TASKS_LINE,
          TODO_TOOLS_LINE,
          USAGE_NOTES_LINE,
          TODO_LINKS_LINE,
          GITHUB_LINK_WATCH_LINE,
        ],
      },
    ])
    // A session that had the first gets only the ones added since (#407, #578).
    expect(missingContext(check({ recorded: has(1) }))).toEqual([
      {
        kind: MissingContextKind.Updates,
        updates: [
          LINK_ARTIFACTS_LINE,
          OTHER_TASKS_LINE,
          TODO_TOOLS_LINE,
          USAGE_NOTES_LINE,
          TODO_LINKS_LINE,
          GITHUB_LINK_WATCH_LINE,
        ],
      },
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
      missingContext(
        check({
          recorded: {
            instructions: false,
            instructionUpdates: 0,
            instructionUpdateHash: hashLines([]),
            handoffAt: null,
            sandbox: false,
            todoHub: false,
          },
        }),
      ),
    ).toMatchObject([{ kind: MissingContextKind.Instructions }])
  })
})

describe("what a session is missing when a line's wording changed, not just its count (#708)", () => {
  it('is nothing when the recorded fingerprint matches the text its count says it has', () => {
    expect(missingContext(check({ recorded: has(CURRENT) }))).toEqual([])
    expect(missingContext(check({ recorded: has(2) }))).toEqual([
      { kind: MissingContextKind.Updates, updates: INSTRUCTION_UPDATES.slice(2) },
    ])
  })

  it('is the whole list again when a line within the count has since been reworded', () => {
    // A session that had already counted all of them, under an earlier wording of one (#680's TODO_TOOLS_LINE):
    // counting alone says it has everything, but the fingerprint of what it actually saw no longer matches.
    const stale = has(CURRENT, null, false, true, hashLines(['an earlier wording of the whole list']))

    expect(missingContext(check({ recorded: stale }))).toEqual([
      { kind: MissingContextKind.Updates, updates: INSTRUCTION_UPDATES },
    ])
    // Sent once, the recorded fingerprint catches up, so it isn't sent again.
    const told = contextAfter(check({ recorded: stale }), missingContext(check({ recorded: stale })))
    expect(told).toEqual(has(CURRENT))
    expect(missingContext(check({ recorded: told }))).toEqual([])
  })

  it('resends the changed-and-seen prefix together with any genuinely new suffix, in one block', () => {
    // Behind by count (hasn't had the last line yet) and its earlier wording was reworded too: both come back as
    // one ordered block — the whole list — not two separate ones.
    const stale = has(CURRENT - 1, null, false, true, hashLines(['stale']))

    expect(missingContext(check({ recorded: stale }))).toEqual([
      { kind: MissingContextKind.Updates, updates: INSTRUCTION_UPDATES },
    ])
  })
})

describe('what a session is missing of the sandbox', () => {
  const sandbox = { kind: MissingContextKind.Sandbox } as const

  it('is nothing for a session that started in it, or that runs outside it', () => {
    expect(startedContext(null, true)).toEqual(has(CURRENT, null, true))
    expect(missingContext(check({ recorded: startedContext(null, true), sandboxed: true }))).toEqual([])
    // Outside the sandbox there's nothing to say of it, whatever the session was told before.
    expect(missingContext(check({ recorded: startedContext(null, false), sandboxed: false }))).toEqual([])
    expect(missingContext(check({ recorded: startedContext(null, true), sandboxed: false }))).toEqual([])
  })

  it('is what the prompt says of it, for a session that started outside it and runs in it now', () => {
    expect(missingContext(check({ recorded: startedContext(null, false), sandboxed: true }))).toEqual([sandbox])
    // One from before anything was recorded started outside it too.
    expect(missingContext(check({ sandboxed: true }))).toEqual([
      {
        kind: MissingContextKind.Updates,
        updates: [
          FINAL_REPLY_LINE,
          LINK_ARTIFACTS_LINE,
          OTHER_TASKS_LINE,
          TODO_TOOLS_LINE,
          USAGE_NOTES_LINE,
          TODO_LINKS_LINE,
          GITHUB_LINK_WATCH_LINE,
        ],
      },
      sandbox,
      TODO_HUB,
    ])
  })

  it('comes after the instructions added since, and before the handoff note', () => {
    expect(missingContext(check({ recorded: has(1), handoff: HANDOFF, sandboxed: true }))).toEqual([
      {
        kind: MissingContextKind.Updates,
        updates: [
          LINK_ARTIFACTS_LINE,
          OTHER_TASKS_LINE,
          TODO_TOOLS_LINE,
          USAGE_NOTES_LINE,
          TODO_LINKS_LINE,
          GITHUB_LINK_WATCH_LINE,
        ],
      },
      sandbox,
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
  })

  it("is covered by Glade's whole prompt for a session that started elsewhere, as that prompt is now", () => {
    const instructions = { kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: null } as const

    expect(missingContext(check({ startedElsewhere: true, sandboxed: true }))).toEqual([instructions])
    // The prompt it's sent in the sandbox says so; the one it's sent outside it doesn't.
    expect(contextAfter(check({ startedElsewhere: true, sandboxed: true }), [instructions])).toEqual(
      has(CURRENT, null, true),
    )
    expect(contextAfter(check({ startedElsewhere: true, sandboxed: false }), [instructions])).toEqual(has(CURRENT))
    expect(missingContext(check({ startedElsewhere: true, recorded: has(CURRENT), sandboxed: true }))).toEqual([
      sandbox,
    ])
  })

  it('is recorded as given once sent, keeping the rest, and never taken back', () => {
    const stale = check({ recorded: has(0, 1_000), sandboxed: true })

    expect(contextAfter(stale, [sandbox])).toEqual(has(0, 1_000, true))
    expect(contextAfter(check({ recorded: has(CURRENT, null, true) }), [])).toEqual(has(CURRENT, null, true))
    // A session told of it stays told when its whole prompt is sent again outside the sandbox.
    const instructions = { kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: null } as const
    const told: SessionContext = {
      instructions: false,
      instructionUpdates: 0,
      instructionUpdateHash: hashLines([]),
      handoffAt: null,
      sandbox: true,
      todoHub: false,
    }
    expect(contextAfter(check({ recorded: told, sandboxed: false }), [instructions])).toEqual(has(CURRENT, null, true))
  })

  it('is said in a block of its own, between the others', () => {
    const block = `[Glade: this session now runs in a sandbox]\n${SANDBOX_LINE}\n[end]`
    const updates = { kind: MissingContextKind.Updates, updates: [FINAL_REPLY_LINE] } as const
    const handoff = { kind: MissingContextKind.Handoff, handoff: HANDOFF } as const

    expect(contextBlock([sandbox])).toBe(block)
    expect(contextBlock([updates, sandbox, handoff])).toBe(
      [contextBlock([updates]), block, contextBlock([handoff])].join('\n\n'),
    )
    expect(withContext(contextBlock([sandbox]), 'Carry on.')).toBe(`${block}\n\nCarry on.`)
  })
})

describe('what a session is missing of the todo hub', () => {
  const todoHub = { kind: MissingContextKind.TodoHub } as const
  const BLOCK = `[Glade: this session now files what it makes under its todos]\n${TODO_HUB_LINES.join('\n\n')}\n[end]`

  it('is nothing for a session Glade starts, in the sandbox or out of it', () => {
    expect(startedContext(null, false)).toEqual(has(CURRENT, null, false, true))
    expect(startedContext(null, true)).toEqual(has(CURRENT, null, true, true))
    expect(missingContext(check({ recorded: startedContext(null, false) }))).toEqual([])
  })

  it('is what the prompt says of it, for a session that started before every session had it (#501)', () => {
    expect(missingContext(check({ recorded: BEFORE_HUB }))).toEqual([todoHub])
    // One from before anything was recorded started without it too.
    expect(missingContext(check({}))).toEqual([
      {
        kind: MissingContextKind.Updates,
        updates: [
          FINAL_REPLY_LINE,
          LINK_ARTIFACTS_LINE,
          OTHER_TASKS_LINE,
          TODO_TOOLS_LINE,
          USAGE_NOTES_LINE,
          TODO_LINKS_LINE,
          GITHUB_LINK_WATCH_LINE,
        ],
      },
      todoHub,
    ])
  })

  it('comes after the instructions added since and the sandbox, and before the handoff note', () => {
    expect(missingContext(check({ recorded: has(1, null, false, false), handoff: HANDOFF, sandboxed: true }))).toEqual([
      {
        kind: MissingContextKind.Updates,
        updates: [
          LINK_ARTIFACTS_LINE,
          OTHER_TASKS_LINE,
          TODO_TOOLS_LINE,
          USAGE_NOTES_LINE,
          TODO_LINKS_LINE,
          GITHUB_LINK_WATCH_LINE,
        ],
      },
      { kind: MissingContextKind.Sandbox },
      todoHub,
      { kind: MissingContextKind.Handoff, handoff: HANDOFF },
    ])
  })

  it('is recorded as given once sent, without touching how many instructions the session has had', () => {
    // A session two instructions behind, sent only the hub's lines (say the others went with an earlier message).
    expect(contextAfter(check({ recorded: has(1, 1_000, true, false) }), [todoHub])).toEqual(has(1, 1_000, true, true))
    // Sent with the instructions added since, each is recorded for itself.
    const stale = check({ recorded: has(0, null, false, false) })
    expect(contextAfter(stale, missingContext(stale))).toEqual(has(CURRENT, null, false, true))
    // Sent once: it isn't missing again.
    const told = contextAfter(stale, missingContext(stale))
    expect(missingContext(check({ recorded: told }))).toEqual([])
    expect(contextAfter(check({ recorded: told }), [])).toEqual(told)
  })

  it("is covered by Glade's whole prompt for a session that started elsewhere, as that prompt is now", () => {
    const instructions = { kind: MissingContextKind.Instructions, prompt: PROMPT, handoffAt: null } as const

    expect(missingContext(check({ startedElsewhere: true }))).toEqual([instructions])
    expect(contextAfter(check({ startedElsewhere: true }), [instructions])).toEqual(has(CURRENT, null, false, true))
    // One sent Glade's prompt before the hub is missing the hub alone.
    expect(missingContext(check({ startedElsewhere: true, recorded: BEFORE_HUB }))).toEqual([todoHub])
  })

  it('is said in a block of its own: how a child is filed, an artifact’s todo, and the hub’s tools', () => {
    const updates = { kind: MissingContextKind.Updates, updates: [FINAL_REPLY_LINE] } as const
    const handoff = { kind: MissingContextKind.Handoff, handoff: HANDOFF } as const

    expect(contextBlock([todoHub])).toBe(BLOCK)
    expect(BLOCK).toContain(TODO_HUB_FILING_LINE)
    expect(BLOCK).toContain(TODO_HUB_ARTIFACTS_LINE)
    // The line #496 left out of what a resumed session is sent comes with them.
    expect(BLOCK).toContain(TODO_HUB_TOOLS_LINE)
    expect(contextBlock([updates, todoHub, handoff])).toBe(
      [contextBlock([updates]), BLOCK, contextBlock([handoff])].join('\n\n'),
    )
    expect(withContext(contextBlock([todoHub]), 'Carry on.')).toBe(`${BLOCK}\n\nCarry on.`)
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
    expect(contextAfter(check({}), [])).toEqual(has(0, null, false, false))
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

describe('what a session is missing of a changed tool (#709)', () => {
  const UPDATE_TODO: ToolSignature = {
    name: 'update_todo',
    description: 'pending, in_progress or completed',
    inputSchema: { type: 'object' },
  }
  const CREATE_TODO: ToolSignature = { name: 'create_todo', description: 'Add a todo.', inputSchema: {} }

  it('is nothing for a tool recorded with its current fingerprint, and for one never recorded at all', () => {
    const recorded = new Map([[UPDATE_TODO.name, toolFingerprint(UPDATE_TODO)]])

    expect(missingToolChanges([UPDATE_TODO], recorded)).toEqual([])
    // Never recorded: new to this session, not changed. It's recorded the first time, not reported.
    expect(missingToolChanges([UPDATE_TODO], new Map())).toEqual([])
  })

  it("is the tool, named with its current description, when its recorded fingerprint doesn't match", () => {
    const changedDescription: ToolSignature = {
      ...UPDATE_TODO,
      description: 'pending, in_progress, completed or waiting',
    }
    const recorded = new Map([[UPDATE_TODO.name, toolFingerprint(UPDATE_TODO)]])

    expect(missingToolChanges([changedDescription], recorded)).toEqual([
      {
        kind: MissingContextKind.ToolChanges,
        changes: [{ name: 'update_todo', description: changedDescription.description }],
      },
    ])
  })

  it('names only the ones that changed, in order, among several offered', () => {
    const changedDescription: ToolSignature = {
      ...UPDATE_TODO,
      description: 'pending, in_progress, completed or waiting',
    }
    const recorded = new Map([
      [UPDATE_TODO.name, toolFingerprint(UPDATE_TODO)],
      [CREATE_TODO.name, toolFingerprint(CREATE_TODO)],
    ])

    expect(missingToolChanges([changedDescription, CREATE_TODO], recorded)).toEqual([
      {
        kind: MissingContextKind.ToolChanges,
        changes: [{ name: 'update_todo', description: changedDescription.description }],
      },
    ])
  })

  it('is said in a block of its own, one line per changed tool, naming its current description', () => {
    const toolChanges = {
      kind: MissingContextKind.ToolChanges,
      changes: [
        { name: 'update_todo', description: 'pending, in_progress, completed or waiting' },
        { name: 'create_todo', description: 'Add a todo.' },
      ],
    } as const

    expect(contextBlock([toolChanges])).toBe(
      [
        '[Glade: a tool changed since this session last saw it]',
        '`update_todo` now: pending, in_progress, completed or waiting',
        '`create_todo` now: Add a todo.',
        '[end]',
      ].join('\n'),
    )
  })

  it("isn't about SessionContext: contextAfter passes it through unchanged", () => {
    const toolChanges = { kind: MissingContextKind.ToolChanges, changes: [] } as const
    const stale = check({ recorded: has(1) })

    expect(contextAfter(stale, [toolChanges])).toEqual(has(1))
  })
})
