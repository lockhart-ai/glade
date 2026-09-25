/**
 * What a task's agent session needs of what Glade tells it, and how it's given it (`docs/control-api.md`, "Backfilling
 * past tasks"; `docs/sdk-notes.md` §8).
 *
 * Glade tells a session things in its system prompt append (`./system-prompt`): its instructions, and the task's
 * handoff note when it has one. Claude Code applies the append only when a session starts: a resumed session keeps the
 * prompt it started with. So a session that started without them, or from before the handoff note it has now, is sent
 * what it's missing once, as a block ahead of the next message Glade sends it. The chat log keeps only the message.
 *
 * What each task's session has been given is kept in SQLite (`../db/repositories/session-context`), so a relaunch
 * neither loses a block still to send nor sends one twice.
 */
import type { EpochMs, TaskHandoff } from '../../shared/domain'
import type { SessionContext } from '../db/repositories/session-context'
import { handoffSection } from './system-prompt'

/** What a session is missing, to send it ahead of the next message. */
export enum MissingContextKind {
  /** Glade's whole system prompt append: the session didn't start with it (one imported from Claude Code). */
  Instructions = 'instructions',
  /** The task's handoff note: set or changed since the session started or was last sent it. */
  Handoff = 'handoff',
}

export type MissingContext =
  | { readonly kind: MissingContextKind.Instructions; readonly prompt: string; readonly handoffAt: EpochMs | null }
  | { readonly kind: MissingContextKind.Handoff; readonly handoff: TaskHandoff }

/** What a session Glade starts has: everything its prompt says, which is all there is to say. */
export function startedContext(handoff: TaskHandoff | null): SessionContext {
  return { instructions: true, handoffAt: handoff?.addedAt ?? null }
}

/** What a task wants its session to have now, and what it has been given. */
export interface ContextCheck {
  /** What's recorded for its session; undefined when nothing is. */
  readonly recorded: SessionContext | undefined
  /**
   * Whether its session started outside Glade (imported from Claude Code), so without Glade's prompt, when nothing's
   * recorded for it. A session Glade started had it.
   */
  readonly startedElsewhere: boolean
  readonly handoff: TaskHandoff | null
  /** Glade's system prompt append for the session as it is now, handoff note and all. */
  readonly prompt: string
}

/** What a task's session is missing, or null when it has everything. */
export function missingContext({ recorded, startedElsewhere, handoff, prompt }: ContextCheck): MissingContext | null {
  const has = recorded ?? { instructions: !startedElsewhere, handoffAt: null }
  if (!has.instructions) return { kind: MissingContextKind.Instructions, prompt, handoffAt: handoff?.addedAt ?? null }
  if (handoff !== null && has.handoffAt !== handoff.addedAt) return { kind: MissingContextKind.Handoff, handoff }
  return null
}

/** What the session has once it's been sent what it was missing. */
export function contextAfter(missing: MissingContext): SessionContext {
  switch (missing.kind) {
    case MissingContextKind.Instructions:
      return { instructions: true, handoffAt: missing.handoffAt }
    case MissingContextKind.Handoff:
      return { instructions: true, handoffAt: missing.handoff.addedAt }
  }
}

/** The block the session is sent ahead of a message's text, with what it was missing. */
export function contextBlock(missing: MissingContext): string {
  switch (missing.kind) {
    case MissingContextKind.Instructions:
      return `[Glade: instructions for this session]\n${missing.prompt}\n[end]`
    case MissingContextKind.Handoff:
      return `[Glade: handoff for this task]\n${handoffSection(missing.handoff)}\n[end]`
  }
}

/** A message's text as the session is sent it: after the block, when there is one. */
export function withContext(block: string | null, text: string): string {
  return block === null ? text : `${block}\n\n${text}`
}
