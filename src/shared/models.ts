// The models and efforts the pickers offer (the input bar's, and Settings' defaults for new tasks), and how they name
// them. One place, so the list stays small and correct: the current Opus, Sonnet and Haiku, by the ids the SDK takes
// (see `docs/sdk-notes.md`).
import { Effort } from './domain'

/** One model the picker offers. */
export interface ModelOption {
  /** The model id, as the SDK names it. */
  readonly id: string
  /** What the picker shows. */
  readonly name: string
}

/** The models the picker offers, most capable first. The first is the default for a new task until Settings changes it. */
export const MODEL_OPTIONS: readonly [ModelOption, ...ModelOption[]] = [
  { id: 'claude-opus-5-5[1m]', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5' },
]

/** A model's friendly name, or its id when the picker doesn't offer it (e.g. a task made with an older model). */
export function modelName(id: string): string {
  return MODEL_OPTIONS.find((option) => option.id === id)?.name ?? id
}

/** What the effort pickers call each level. */
export const EFFORT_NAMES: Readonly<Record<Effort, string>> = {
  [Effort.Low]: 'Low',
  [Effort.Medium]: 'Medium',
  [Effort.High]: 'High',
  [Effort.Max]: 'Max',
}
