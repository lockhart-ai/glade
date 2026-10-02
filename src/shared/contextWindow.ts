// How big a model's context window is, for the context meter. The SDK reports the real size on each turn's `result`
// (`modelUsage[model].contextWindow`, see `docs/sdk-notes.md`, "Usage and context size"): the agent runner keeps that
// on the task, and remembers it by model for the next task or model change on the same model. Before the SDK has said
// for a model, the window is a guess from what Glade knows of it (`guessContextWindow` in `./models`). Whatever the
// window, the meter never shows more used than it holds (`fitContextWindow`).

/** The window every current model has by default. */
export const STANDARD_CONTEXT_WINDOW = 200_000

/**
 * The window of a model's 1M-context variant, which the SDK names with a `[1m]` suffix, e.g. `claude-opus-5-5[1m]`.
 * Some models have it without the suffix: Opus 5.5 runs at 1M as `claude-opus-5-5`.
 */
export const EXTENDED_CONTEXT_WINDOW = 1_000_000

/** The windows the SDK gives models, smallest first. */
const KNOWN_WINDOWS = [STANDARD_CONTEXT_WINDOW, EXTENDED_CONTEXT_WINDOW] as const

/** The suffix the SDK gives a model's 1M-context variant, which it matches whatever the case. */
const EXTENDED_SUFFIX = /\[1m\]$/i

/** Whether a model id names a 1M-context variant: `opus[1m]`, `claude-opus-5-5[1m]`. */
export function isExtendedId(model: string): boolean {
  return EXTENDED_SUFFIX.test(model)
}

/** A model id without its 1M-context suffix: `opus[1m]` → `opus`. */
export function withoutExtended(model: string): string {
  return model.replace(EXTENDED_SUFFIX, '')
}

/** Whether a model's name or description says it has a 1M window, e.g. "Opus (1M context)". */
export function mentionsExtended(text: string): boolean {
  return /\b1M\b/.test(text)
}

/** The context window of the model with this id from the id alone: 1M with the `[1m]` suffix, else 200k. */
export function contextWindowFor(model: string): number {
  return isExtendedId(model) ? EXTENDED_CONTEXT_WINDOW : STANDARD_CONTEXT_WINDOW
}

/** A model id as the SDK may spell it in different places: lower case, without a date after it. */
function normalized(model: string): string {
  return model.toLowerCase().replace(/-\d{8}(?=\[1m\]$|$)/, '')
}

/** The window a result reported for the session's model, and the `modelUsage` key it was under. */
export interface ReportedWindow {
  readonly model: string
  readonly window: number
}

/**
 * Which of a result's `modelUsage` windows is the session's (`docs/sdk-notes.md`, "Usage and context size"): the one
 * keyed by the first of `names` that has one (the model `system/init` named, then the model Glade asked for and the
 * full id it stands for), else the one whose key is one of those spelled another way (case, a date), else, with
 * `onlyModel`, the only one, whatever its key. `onlyModel` says the session has run on one model throughout: after a
 * model change a lone entry may be the model before it (a turn that ended before the new model answered), so it isn't
 * taken. Undefined when none matches: they're other models (a subagent's, or the one before a model change), and none
 * of them is sure to be the session's.
 */
export function matchReportedWindow(
  windows: Readonly<Record<string, number>>,
  names: readonly string[],
  onlyModel: boolean,
): ReportedWindow | undefined {
  for (const name of names) {
    const window = windows[name]
    if (window !== undefined) return { model: name, window }
  }
  const entries = Object.entries(windows)
  const wanted = new Set(names.map(normalized))
  const found =
    entries.find(([model]) => wanted.has(normalized(model))) ??
    (onlyModel && entries.length === 1 ? entries[0] : undefined)
  return found === undefined ? undefined : { model: found[0], window: found[1] }
}

/**
 * The window to show for `windowTokens` when `evidenceTokens` are known to fit in it (the context used): the window
 * itself when they fit, else the smallest window the SDK gives that holds them, else
 * the evidence itself. More used than the window holds proves the window wrong, so the larger observed size wins.
 */
export function fitContextWindow(windowTokens: number, evidenceTokens: number): number {
  if (evidenceTokens <= windowTokens) return windowTokens
  return KNOWN_WINDOWS.find((window) => window >= evidenceTokens) ?? evidenceTokens
}

/**
 * What the SDK keeps free below the window for the summary compaction writes: its "effective window" is the window
 * less this.
 */
const SUMMARY_RESERVE_TOKENS = 20_000

/** The buffer the SDK leaves between its effective window and where it compacts automatically. */
const AUTO_COMPACT_BUFFER_TOKENS = 13_000

/**
 * Where the SDK compacts a session automatically, in tokens, for a context window of `windowTokens`: its default
 * auto-compact threshold, which Glade keeps (`docs/decisions.md`). The SDK puts it at its effective window (the window
 * less the summary's reserve) less a 13k buffer (`docs/sdk-notes.md` §5, from the bundled CLI, which may change), so
 * 167k for a 200k window, as `getContextUsage()` reported, and 967k for 1M. This is the one place Glade works it out.
 */
export function autoCompactThreshold(windowTokens: number): number {
  return Math.max(0, windowTokens - SUMMARY_RESERVE_TOKENS - AUTO_COMPACT_BUFFER_TOKENS)
}
