/**
 * What a task's agent session needs of what Glade tells it, and how it's given it (`docs/control-api.md`, "Backfilling
 * past tasks"; `docs/sdk-notes.md` §8).
 *
 * Glade tells a session things in its system prompt append (`./system-prompt`): its instructions, and the task's
 * handoff note when it has one. Claude Code applies the append only when a session starts: a resumed session keeps the
 * prompt it started with. So a session that started without them, before instructions added to them since
 * (`INSTRUCTION_UPDATES`), or from before the handoff note it has now, is sent what it's missing once, in blocks ahead
 * of the next message Glade sends it. The chat log keeps only the message.
 *
 * What each task's session has been given is kept in SQLite (`../db/repositories/session-context`), so a relaunch
 * neither loses a block still to send nor sends one twice.
 */
import type { EpochMs, TaskHandoff } from '../../shared/domain'
import type { SessionContext } from '../db/repositories/session-context'
import { handoffSection, INSTRUCTION_UPDATES } from './system-prompt'

/** What a session is missing, to send it ahead of the next message. */
export enum MissingContextKind {
  /** Glade's whole system prompt append: the session didn't start with it (one imported from Claude Code). */
  Instructions = 'instructions',
  /** The instructions added to Glade's prompt since the session started with it or was sent it. */
  Updates = 'updates',
  /** The task's handoff note: set or changed since the session started or was last sent it. */
  Handoff = 'handoff',
}

export type MissingContext =
  | { readonly kind: MissingContextKind.Instructions; readonly prompt: string; readonly handoffAt: EpochMs | null }
  | { readonly kind: MissingContextKind.Updates; readonly updates: readonly string[] }
  | { readonly kind: MissingContextKind.Handoff; readonly handoff: TaskHandoff }

/** What a session Glade starts has: everything its prompt says, which is all there is to say. */
export function startedContext(handoff: TaskHandoff | null): SessionContext {
  return { instructions: true, instructionUpdates: INSTRUCTION_UPDATES.length, handoffAt: handoff?.addedAt ?? null }
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
}

/** What the task's session has, from what's recorded for it. */
function given({ recorded, startedElsewhere }: ContextCheck): SessionContext {
  return recorded ?? { instructions: !startedElsewhere, instructionUpdates: 0, handoffAt: null }
}

/**
 * What a task's session is missing; none when it has everything. Glade's whole prompt covers the rest; otherwise it's
 * the instructions added since, then a new handoff note, either or both.
 */
export function missingContext(check: ContextCheck): readonly MissingContext[] {
  const { handoff, prompt } = check
  const has = given(check)
  if (!has.instructions) return [{ kind: MissingContextKind.Instructions, prompt, handoffAt: handoff?.addedAt ?? null }]
  const missing: MissingContext[] = []
  const updates = INSTRUCTION_UPDATES.slice(has.instructionUpdates)
  if (updates.length > 0) missing.push({ kind: MissingContextKind.Updates, updates })
  if (handoff !== null && has.handoffAt !== handoff.addedAt) missing.push({ kind: MissingContextKind.Handoff, handoff })
  return missing
}

/** What the session has once it's been sent what it was missing. */
export function contextAfter(check: ContextCheck, missing: readonly MissingContext[]): SessionContext {
  return missing.reduce<SessionContext>((has, item) => {
    switch (item.kind) {
      case MissingContextKind.Instructions:
        return { instructions: true, instructionUpdates: INSTRUCTION_UPDATES.length, handoffAt: item.handoffAt }
      case MissingContextKind.Updates:
        return { ...has, instructionUpdates: INSTRUCTION_UPDATES.length }
      case MissingContextKind.Handoff:
        return { ...has, handoffAt: item.handoff.addedAt }
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
    case MissingContextKind.Handoff:
      return `[Glade: handoff for this task]\n${handoffSection(missing.handoff)}\n[end]`
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
