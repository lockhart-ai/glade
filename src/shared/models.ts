// The models and efforts the pickers offer (the input bar's, Settings' defaults for new tasks, and Retry with another
// model), and how they name them. The list is the SDK's: each session reports the models the user's Claude Code login
// offers as it starts (`docs/sdk-notes.md` §4), and main keeps the latest in SQLite. Until the first session reports
// it, the pickers offer the built-in list below.
import { Effort } from './domain'

/** One model the pickers offer, as the SDK reports it (its `ModelInfo`), parsed at the boundary. */
export interface ModelChoice {
  /** The model id, as the SDK takes it: a full id (`claude-sonnet-5`) or an alias (`sonnet`, `default`). */
  readonly id: string
  /** The full id `id` stands for (`sonnet` → `claude-sonnet-5`); null when the SDK doesn't say. */
  readonly resolvedModel: string | null
  /** What the pickers show. */
  readonly name: string
  /** A line on what it's for, e.g. "Sonnet 5 · Efficient for routine tasks"; may be empty. */
  readonly description: string
  /** The effort levels it supports, lowest first; none for a model that doesn't take an effort (Haiku). */
  readonly efforts: readonly Effort[]
}

/** Every effort level, lowest first. */
export const ALL_EFFORTS: readonly Effort[] = Object.values(Effort)

/**
 * The models the pickers offer until a session first reports the SDK's list: the current Opus, Sonnet and Haiku, by the
 * full ids the SDK takes. The first is the default for a new task until Settings changes it.
 */
export const BUILT_IN_MODELS: readonly [ModelChoice, ...ModelChoice[]] = [
  {
    id: 'claude-opus-5-5[1m]',
    resolvedModel: 'claude-opus-5-5[1m]',
    name: 'Opus 5.5',
    description: '',
    efforts: ALL_EFFORTS,
  },
  { id: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', name: 'Sonnet 5', description: '', efforts: ALL_EFFORTS },
  { id: 'claude-haiku-4-5', resolvedModel: 'claude-haiku-4-5', name: 'Haiku 4.5', description: '', efforts: [] },
]

/**
 * The model `id` is among `models`: the one with that id, else the first whose full id it is (a task saved with
 * `claude-sonnet-5` is on the `sonnet` alias's model). Undefined for a model the list doesn't have: an unknown one, or
 * one the SDK no longer offers.
 */
export function findModel(models: readonly ModelChoice[], id: string): ModelChoice | undefined {
  return models.find((model) => model.id === id) ?? models.find((model) => model.resolvedModel === id)
}

/** A model's name, or its id when the list doesn't have it (e.g. a task made with a model since removed). */
export function modelName(models: readonly ModelChoice[], id: string): string {
  return findModel(models, id)?.name ?? id
}

/**
 * The effort levels the effort picker offers for model `id`: its own, none when it takes no effort, and every level
 * for a model the list doesn't have, since there's no telling which it takes.
 */
export function effortsOf(models: readonly ModelChoice[], id: string): readonly Effort[] {
  return findModel(models, id)?.efforts ?? ALL_EFFORTS
}

/** The effort a model starts on when the one saved isn't one it supports: High where it has it, else its first. */
export function defaultEffortOf(efforts: readonly Effort[]): Effort {
  return efforts.includes(Effort.High) ? Effort.High : (efforts[0] ?? Effort.High)
}

/**
 * The effort to keep with model `id`: `effort` itself when the model supports it, takes none (it's kept for the next
 * model) or isn't in the list; otherwise the model's default (`defaultEffortOf`).
 */
export function effortFor(models: readonly ModelChoice[], id: string, effort: Effort): Effort {
  const efforts = effortsOf(models, id)
  if (efforts.length === 0 || efforts.includes(effort)) return effort
  return defaultEffortOf(efforts)
}

/** What the effort pickers call each level. */
export const EFFORT_NAMES: Readonly<Record<Effort, string>> = {
  [Effort.Low]: 'Low',
  [Effort.Medium]: 'Medium',
  [Effort.High]: 'High',
  [Effort.XHigh]: 'Extra high',
  [Effort.Max]: 'Max',
}

/**
 * What says an effort fell back when the model changed: e.g. "Haiku doesn't offer Max effort, so it's now High." Null
 * when it didn't.
 */
export function effortFallbackNotice(
  models: readonly ModelChoice[],
  id: string,
  from: Effort,
  to: Effort,
): string | null {
  if (from === to) return null
  return `${modelName(models, id)} doesn’t offer ${EFFORT_NAMES[from]} effort, so it’s now ${EFFORT_NAMES[to]}.`
}
