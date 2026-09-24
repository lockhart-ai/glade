// How big a model's context window is, for the context meter. The SDK reports the real size on each turn's `result`
// (`modelUsage[model].contextWindow`, see `docs/sdk-notes.md`, "Usage and context size"), and the agent runner keeps
// that on the task. This is what a task shows before the SDK has said: a new task, or one whose model just changed.

/** The window every current model has by default. */
export const STANDARD_CONTEXT_WINDOW = 200_000

/** The window of a model's 1M-context variant, which the SDK names with a `[1m]` suffix, e.g. `claude-opus-5-5[1m]`. */
export const EXTENDED_CONTEXT_WINDOW = 1_000_000

/** The suffix the SDK gives a model's 1M-context variant. */
const EXTENDED_SUFFIX = '[1m]'

/** The context window of the model with this id, as the SDK names it, in tokens. */
export function contextWindowFor(model: string): number {
  return model.endsWith(EXTENDED_SUFFIX) ? EXTENDED_CONTEXT_WINDOW : STANDARD_CONTEXT_WINDOW
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
