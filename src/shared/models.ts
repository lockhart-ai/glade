// The models and efforts the pickers offer (the input bar's, Settings' defaults for new tasks, and Retry with another
// model), and how they name them. The list is the SDK's: each session reports the models the user's Claude Code login
// offers as it starts (`docs/sdk-notes.md` §4), and main keeps the latest in SQLite. Until the first session reports
// it, the pickers offer the built-in list below.
import {
  EXTENDED_CONTEXT_WINDOW,
  isExtendedId,
  mentionsExtended,
  STANDARD_CONTEXT_WINDOW,
  withoutExtended,
} from './contextWindow'
import { Effort } from './domain'
import type { AgentSource } from './openrouter'

/** One model the pickers offer, as the SDK reports it (its `ModelInfo`), parsed at the boundary. */
export interface ModelChoice {
  readonly source?: AgentSource
  readonly provider?: string
  readonly contextLength?: number
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

/** A full model id without the date after it: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
function undated(id: string): string {
  return id.replace(/-\d{8}$/, '')
}

/** A word with its first letter in capitals: `opus` → `Opus`. */
function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * The name a full model id spells out, without the date after it: `claude-opus-5-5` → "Opus 5.5",
 * `claude-haiku-4-5-20251001` → "Haiku 4.5", `claude-3-7-sonnet` → "Sonnet 3.7". Undefined for an id that isn't one.
 */
function nameFromFullId(id: string): string | undefined {
  const bare = undated(id.toLowerCase())
  const current = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(bare)
  if (current?.[1] !== undefined && current[2] !== undefined) {
    return `${capitalized(current[1])} ${current[2].replace('-', '.')}`
  }
  const legacy = /^claude-(\d+(?:-\d+)?)-([a-z]+)$/.exec(bare)
  if (legacy?.[1] !== undefined && legacy[2] !== undefined) {
    return `${capitalized(legacy[2])} ${legacy[1].replace('-', '.')}`
  }
  return undefined
}

/**
 * The name of an alias the list doesn't have, like `opus` or `default`: the newest model of that family the list
 * offers (the SDK lists the newest first), named from its full id, e.g. "Opus 5.5"; else the alias in capitals. Undefined
 * for an id that isn't an alias.
 */
function aliasName(models: readonly ModelChoice[], alias: string): string | undefined {
  if (!/^[a-z]+$/i.test(alias)) return undefined
  const family = `claude-${alias.toLowerCase()}-`
  for (const model of models) {
    for (const id of [model.resolvedModel, model.id]) {
      const full = id === null ? undefined : withoutExtended(id)
      const name = full?.toLowerCase().startsWith(family) === true ? nameFromFullId(full) : undefined
      if (name !== undefined) return name
    }
  }
  return capitalized(alias)
}

/** A name with "(1M)" after it, unless it already says 1M ("Opus (1M context)"). */
function withExtended(name: string): string {
  return mentionsExtended(name) ? name : `${name} (1M)`
}

/** The SDK's alias for its default choice, which it names as a choice ("Default (recommended)"), not as a model. */
const DEFAULT_ALIAS = 'default'

/** The models other than the SDK's default choice. */
function withoutDefault(models: readonly ModelChoice[]): readonly ModelChoice[] {
  return models.filter((model) => model.id !== DEFAULT_ALIAS)
}

/**
 * A model's name, for every id the SDK can report, never the raw id where there's a better one: the list's name for
 * it, or for the same model with a date after it (`claude-haiku-4-5-20251001` is the `claude-haiku-4-5` row); for a
 * 1M variant the list doesn't have, its base model's name with "(1M)" (`opus[1m]` → "Opus 5.5 (1M)"); else the name its
 * full id spells out ("Opus 4.8"), or the newest of an alias's family the list has. The id itself only for one that's
 * none of those (e.g. a custom model).
 */
export function modelName(models: readonly ModelChoice[], id: string): string {
  const listed =
    findModel(models, id) ??
    models.find((model) =>
      [model.id, model.resolvedModel].some((full) => full !== null && undated(full) === undated(id)),
    )
  if (listed !== undefined) return listed.name
  const base = withoutExtended(id)
  // Named after the model itself, not the default choice that happens to stand for it ("Default (recommended)").
  if (base !== id) return withExtended(modelName(base === DEFAULT_ALIAS ? models : withoutDefault(models), base))
  return nameFromFullId(id) ?? aliasName(models, id) ?? id
}

/**
 * What the model picker's button says for a task: its model's name (`modelName`), with "(1M)" when the task's window
 * is 1M or more and the name doesn't already say so, so a task on Opus 5.5 that runs at 1M reads "Opus 5.5 (1M)". The
 * SDK's default choice keeps its own name ("Default (recommended)"): it names a choice, not a model.
 */
export function modelLabel(models: readonly ModelChoice[], id: string, windowTokens: number): string {
  const name = modelName(models, id)
  const isDefault = (findModel(models, id)?.id ?? id) === DEFAULT_ALIAS
  return windowTokens >= EXTENDED_CONTEXT_WINDOW && !isDefault ? withExtended(name) : name
}

/** One option of a model picker: the model's id, as the SDK takes it, and what the picker calls it. */
export interface ModelOption {
  readonly id: string
  readonly name: string
}

/**
 * The model each picker offers: the list's models in the SDK's order, but with each 1M variant (`[1m]`) right after
 * its base model, and with the current model `current` always there, so the picker can check it. A current model the
 * list doesn't have (a task saved with `opus[1m]` after the SDK stopped offering it, a model since retired, or one an
 * import brought) goes after its base model if the list has that, else last, named by `currentName`.
 */
export function modelOptions(
  models: readonly ModelChoice[],
  current: string,
  currentName: string = modelName(models, current),
): readonly ModelOption[] {
  const options: ModelOption[] = []
  const baseOf = (model: ModelChoice): ModelChoice | undefined =>
    isExtendedId(model.id) ? findModel(models, withoutExtended(model.id)) : undefined
  for (const model of models) {
    if (baseOf(model) !== undefined) continue
    options.push({ id: model.id, name: model.name })
    for (const variant of models.filter((other) => baseOf(other) === model)) {
      options.push({ id: variant.id, name: variant.name })
    }
  }
  if (findModel(models, current) !== undefined) return options
  const base = isExtendedId(current) ? findModel(models, withoutExtended(current)) : undefined
  const at = base === undefined ? options.length : options.findIndex((option) => option.id === base.id) + 1
  options.splice(at, 0, { id: current, name: currentName })
  return options
}

/**
 * The best guess at model `model`'s context window before its session reports one: what the SDK last reported for
 * that model (`reported`, by its id or the full id the list says it stands for), else 1M if either id has the `[1m]`
 * suffix or the list's name or description says 1M ("Opus 5.5 with 1M context"), else the standard 200k.
 */
export function guessContextWindow(
  models: readonly ModelChoice[],
  reported: ReadonlyMap<string, number>,
  model: string,
): number {
  const listed = findModel(models, model)
  const ids = [model, listed?.id, listed?.resolvedModel ?? undefined].filter((id) => id !== undefined)
  for (const id of ids) {
    const window = reported.get(id)
    if (window !== undefined) return window
  }
  if (ids.some(isExtendedId)) return EXTENDED_CONTEXT_WINDOW
  if (listed !== undefined && mentionsExtended(`${listed.name} ${listed.description}`)) return EXTENDED_CONTEXT_WINDOW
  return STANDARD_CONTEXT_WINDOW
}

/**
 * Whether ids `a` and `b` name the same model: the same id, or the same row of the list, or ids the list says stand
 * for the same full id (`default` and `opus[1m]` both stand for `claude-opus-5-5[1m]`).
 */
export function sameModel(models: readonly ModelChoice[], a: string, b: string): boolean {
  if (a === b) return true
  const fullId = (id: string): string => {
    const listed = findModel(models, id)
    return listed?.resolvedModel ?? listed?.id ?? id
  }
  return fullId(a) === fullId(b)
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
