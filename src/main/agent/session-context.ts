/**
 * What a task's agent session needs of what Glade tells it, and how it's given it (`docs/control-api.md`, "Backfilling
 * past tasks"; `docs/sdk-notes.md` §8).
 *
 * Glade tells a session things in its system prompt append (`./system-prompt`): its instructions, and the task's
 * handoff note when it has one. Claude Code applies the append only when a session starts: a resumed session keeps the
 * prompt it started with. So a session that started without them, before instructions added to them since
 * (`INSTRUCTION_UPDATES`), outside the agent sandbox it now runs in (`SANDBOX_LINE`, #452), without what the prompt
 * says of the todo hub (`TODO_HUB_LINES`, #495: a session from before the hub, or from while it was behind its
 * switch, #501), or from before the handoff note it has now, is sent what it's missing once, in blocks ahead of the
 * next message Glade sends it. The chat log keeps only the message.
 *
 * What each task's session has been given is kept in SQLite (`../db/repositories/session-context`), so a relaunch
 * neither loses a block still to send nor sends one twice.
 *
 * The same "once, ahead of the next message" delivery (`MissingContext`, `contextBlock`, `withContext`) also carries
 * a note of a different kind (#709): one of Glade's own tools (`./tool-fingerprint`) that's changed since the
 * session last saw it, named with its current description. What that session has seen of each tool lives in its
 * own table (`../db/repositories/session-tool-fingerprints`), not in `SessionContext`, so it's checked and recorded
 * by the caller (`./runner`) alongside `missingContext`/`contextAfter`, through `missingToolChanges` below.
 */
import type { EpochMs, TaskHandoff } from '../../shared/domain'
import type { SessionContext } from '../db/repositories/session-context'
import { hashLines } from './instruction-hash'
import { handoffSection, INSTRUCTION_UPDATES, SANDBOX_LINE, TODO_HUB_LINES } from './system-prompt'
import { toolFingerprints, type ToolSignature } from './tool-fingerprint'

/**
 * The fingerprint of the first `count` lines of `INSTRUCTION_UPDATES`, as they read now. What a session is recorded
 * as having matches this once it's been sent everything through `count` — until a later release edits one of those
 * lines' text in place instead of appending a new one (#708: #680 did exactly that to `TODO_TOOLS_LINE`), at which
 * point the session's recorded fingerprint (of the wording it actually saw) stops matching this, and it's missing
 * the whole prefix again, not just the line that changed. That's simpler than tracking which one, and safe: telling
 * a session a line it already has correctly is harmless, just said once more.
 */
function instructionPrefixHash(count: number): string {
  return hashLines(INSTRUCTION_UPDATES.slice(0, count))
}

/** What a session is missing, to send it ahead of the next message. */
export enum MissingContextKind {
  /** Glade's whole system prompt append: the session didn't start with it (one imported from Claude Code). */
  Instructions = 'instructions',
  /** The instructions added to Glade's prompt since the session started with it or was sent it. */
  Updates = 'updates',
  /**
   * What the prompt says of the agent sandbox (`SANDBOX_LINE`): the session runs in it now, and started outside it, so
   * its prompt says nothing of it or of asking with `request_access`.
   */
  Sandbox = 'sandbox',
  /**
   * What the prompt says of the todo hub (`TODO_HUB_LINES`): the session started before the hub was on for every task
   * (#501), so its prompt says nothing of naming a todo in a call, of `add_artifact`'s todo, or of the hub's tools.
   */
  TodoHub = 'todo_hub',
  /** The task's handoff note: set or changed since the session started or was last sent it. */
  Handoff = 'handoff',
  /**
   * One of Glade's own tools has changed since the session last saw it (#709): a resumed session can keep Claude
   * Code's own stale view of a tool's schema (see the PR for the spike on why), even though the call it names
   * reaches the live, current server. Unlike the others, this isn't about `SessionContext` (`../db/repositories
   * /session-context`): what each tool's last-seen fingerprint was is kept per tool, not per session as a whole
   * (`../db/repositories/session-tool-fingerprints`), so `missingToolChanges` below is checked and recorded
   * alongside the rest, not through `missingContext`/`contextAfter` themselves.
   */
  ToolChanges = 'tool_changes',
}

/** One of Glade's own tools, changed since a session last saw it: its name and its current description. */
export interface ToolChange {
  readonly name: string
  readonly description: string
}

export type MissingContext =
  | { readonly kind: MissingContextKind.Instructions; readonly prompt: string; readonly handoffAt: EpochMs | null }
  | { readonly kind: MissingContextKind.Updates; readonly updates: readonly string[] }
  | { readonly kind: MissingContextKind.Sandbox }
  | { readonly kind: MissingContextKind.TodoHub }
  | { readonly kind: MissingContextKind.Handoff; readonly handoff: TaskHandoff }
  | { readonly kind: MissingContextKind.ToolChanges; readonly changes: readonly ToolChange[] }

/**
 * What a session Glade starts has: everything its prompt says, which is all there is to say. That includes the
 * todo hub, and the sandbox only when it starts `sandboxed`: outside it, the prompt doesn't mention it.
 */
export function startedContext(handoff: TaskHandoff | null, sandboxed: boolean): SessionContext {
  return {
    instructions: true,
    instructionUpdates: INSTRUCTION_UPDATES.length,
    instructionUpdateHash: instructionPrefixHash(INSTRUCTION_UPDATES.length),
    handoffAt: handoff?.addedAt ?? null,
    sandbox: sandboxed,
    todoHub: true,
  }
}

/** What a task wants its session to have now, and what it has been given. */
export interface ContextCheck {
  /** What's recorded for its session; undefined when nothing is. */
  readonly recorded: SessionContext | undefined
  /**
   * Whether its session started outside Glade (imported from Claude Code), so without Glade's prompt, when nothing's
   * recorded for it. A session Glade started had it, but from before recording began, so none of the instructions
   * added since.
   */
  readonly startedElsewhere: boolean
  readonly handoff: TaskHandoff | null
  /** Glade's system prompt append for the session as it is now, handoff note and all. */
  readonly prompt: string
  /** Whether its session runs in the agent sandbox now. A session keeps the sandbox it started or resumed with. */
  readonly sandboxed: boolean
}

/** What the task's session has, from what's recorded for it. */
function given({ recorded, startedElsewhere }: ContextCheck): SessionContext {
  return (
    recorded ?? {
      instructions: !startedElsewhere,
      instructionUpdates: 0,
      instructionUpdateHash: instructionPrefixHash(0),
      handoffAt: null,
      sandbox: false,
      todoHub: false,
    }
  )
}

/**
 * What a task's session is missing; none when it has everything. Glade's whole prompt covers the rest; otherwise it's
 * the instructions added since, then the sandbox it now runs in and wasn't told of, then the todo hub it wasn't told
 * of, then a new handoff note, any of them. A session that isn't sandboxed is never told of the sandbox, whatever it
 * was told before.
 *
 * "Added since" is two things, not one (#708): lines past `instructionUpdates` (new, by position), and, when the
 * fingerprint of what it already has doesn't match the current text of that prefix, the whole prefix too — a line
 * in it was edited in place rather than appended, so counting alone can't tell. Either way it's sent as one ordered
 * block (a changed prefix plus any genuinely new suffix is just `INSTRUCTION_UPDATES` itself, start to finish).
 */
export function missingContext(check: ContextCheck): readonly MissingContext[] {
  const { handoff, prompt, sandboxed } = check
  const has = given(check)
  if (!has.instructions) return [{ kind: MissingContextKind.Instructions, prompt, handoffAt: handoff?.addedAt ?? null }]
  const missing: MissingContext[] = []
  const prefixChanged = instructionPrefixHash(has.instructionUpdates) !== has.instructionUpdateHash
  const updates = prefixChanged ? INSTRUCTION_UPDATES : INSTRUCTION_UPDATES.slice(has.instructionUpdates)
  if (updates.length > 0) missing.push({ kind: MissingContextKind.Updates, updates })
  if (sandboxed && !has.sandbox) missing.push({ kind: MissingContextKind.Sandbox })
  if (!has.todoHub) missing.push({ kind: MissingContextKind.TodoHub })
  if (handoff !== null && has.handoffAt !== handoff.addedAt) missing.push({ kind: MissingContextKind.Handoff, handoff })
  return missing
}

/**
 * Which of `current` (every tool this session is offered now, across Glade's own MCP servers) have a fingerprint
 * that doesn't match what's recorded for them (`recorded`, from `session_tool_fingerprints`): one it already knew
 * under a different name, description or input schema (#709). A tool with nothing recorded for it is new to this
 * session, not changed — it's recorded the first time it's seen, silently, not reported here.
 */
export function missingToolChanges(
  current: readonly ToolSignature[],
  recorded: ReadonlyMap<string, string>,
): readonly MissingContext[] {
  const fingerprints = toolFingerprints(current)
  const changed = current.filter(({ name }) => {
    const before = recorded.get(name)
    return before !== undefined && before !== fingerprints.get(name)
  })
  if (changed.length === 0) return []
  return [
    { kind: MissingContextKind.ToolChanges, changes: changed.map(({ name, description }) => ({ name, description })) },
  ]
}

/** What the session has once it's been sent what it was missing. */
export function contextAfter(check: ContextCheck, missing: readonly MissingContext[]): SessionContext {
  return missing.reduce<SessionContext>((has, item) => {
    switch (item.kind) {
      case MissingContextKind.Instructions:
        // The prompt it's sent is the one for the session as it runs now, which says of the todo hub, and of the
        // sandbox what applies.
        return {
          instructions: true,
          instructionUpdates: INSTRUCTION_UPDATES.length,
          instructionUpdateHash: instructionPrefixHash(INSTRUCTION_UPDATES.length),
          handoffAt: item.handoffAt,
          sandbox: has.sandbox || check.sandboxed,
          todoHub: true,
        }
      case MissingContextKind.Updates:
        return {
          ...has,
          instructionUpdates: INSTRUCTION_UPDATES.length,
          instructionUpdateHash: instructionPrefixHash(INSTRUCTION_UPDATES.length),
        }
      case MissingContextKind.Sandbox:
        return { ...has, sandbox: true }
      case MissingContextKind.TodoHub:
        return { ...has, todoHub: true }
      case MissingContextKind.Handoff:
        return { ...has, handoffAt: item.handoff.addedAt }
      case MissingContextKind.ToolChanges:
        // Recorded in its own table (`session_tool_fingerprints`), by the caller: nothing here to change.
        return has
    }
  }, given(check))
}

/** The block the session is sent ahead of a message's text for one thing it was missing. */
function blockFor(missing: MissingContext): string {
  switch (missing.kind) {
    case MissingContextKind.Instructions:
      return `[Glade: instructions for this session]\n${missing.prompt}\n[end]`
    case MissingContextKind.Updates:
      return `[Glade: new instructions for this session]\n${missing.updates.join('\n\n')}\n[end]`
    case MissingContextKind.Sandbox:
      return `[Glade: this session now runs in a sandbox]\n${SANDBOX_LINE}\n[end]`
    case MissingContextKind.TodoHub:
      return `[Glade: this session now files what it makes under its todos]\n${TODO_HUB_LINES.join('\n\n')}\n[end]`
    case MissingContextKind.Handoff:
      return `[Glade: handoff for this task]\n${handoffSection(missing.handoff)}\n[end]`
    case MissingContextKind.ToolChanges:
      return [
        '[Glade: a tool changed since this session last saw it]',
        ...missing.changes.map(({ name, description }) => `\`${name}\` now: ${description}`),
        '[end]',
      ].join('\n')
  }
}

/** The blocks the session is sent ahead of a message's text, with what it was missing; null when it's missing none. */
export function contextBlock(missing: readonly MissingContext[]): string | null {
  return missing.length === 0 ? null : missing.map(blockFor).join('\n\n')
}

/** A message's text as the session is sent it: after the block, when there is one. */
export function withContext(block: string | null, text: string): string {
  return block === null ? text : `${block}\n\n${text}`
}
