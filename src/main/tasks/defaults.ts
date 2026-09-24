// The model and effort a new task starts with. One place, until there are settings to choose them.
import { Effort } from '../../shared/domain'

/** The SDK's default model, as it names it (see `docs/sdk-notes.md`, "Usage and context size"). */
export const DEFAULT_MODEL = 'claude-opus-5-5[1m]'

export const DEFAULT_EFFORT = Effort.High
