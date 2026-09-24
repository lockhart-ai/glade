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
