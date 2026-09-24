// The model and effort a new task starts with. One place, until there are settings to choose them.
import { Effort } from '../../shared/domain'
import { MODEL_OPTIONS } from '../../shared/models'

/** The SDK's default model, as it names it (see `docs/sdk-notes.md`, "Usage and context size"): the picker's first. */
export const DEFAULT_MODEL = MODEL_OPTIONS[0].id

export const DEFAULT_EFFORT = Effort.High
