// The models the SDK offers, parsed at the boundary: `initializationResult().models`, a `ModelInfo` each
// (`docs/sdk-notes.md` §4), into the `ModelChoice`s the pickers offer.
import { z } from 'zod'
import { Effort } from '../../shared/domain'
import { ALL_EFFORTS, type ModelChoice } from '../../shared/models'

/** The fields of the SDK's `ModelInfo` Glade reads; the rest (fast mode, auto mode, …) it has no use for. */
const modelInfo = z.object({
  value: z.string().trim().min(1),
  resolvedModel: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1),
  description: z.string().optional(),
  supportsEffort: z.boolean().optional(),
  // Levels as strings: a level the SDK adds later is left out, not the whole model.
  supportedEffortLevels: z.array(z.string()).optional(),
})

type ModelInfo = z.infer<typeof modelInfo>

function isEffort(level: string): level is Effort {
  return Object.values<string>(Effort).includes(level)
}

/**
 * The levels a model supports, lowest first: none unless it says it supports effort, and only the ones Glade knows. A
 * model that supports effort without listing its levels takes every one.
 */
function effortsOf(info: ModelInfo): readonly Effort[] {
  if (info.supportsEffort !== true) return []
  if (info.supportedEffortLevels === undefined) return ALL_EFFORTS
  const levels = new Set(info.supportedEffortLevels.filter(isEffort))
  return ALL_EFFORTS.filter((effort) => levels.has(effort))
}

/**
 * The models in what the SDK reported, in its order: each `ModelInfo` it could read, the first of any id it gives
 * twice. Anything it couldn't read is left out, so a list that isn't one, or has no model Glade can read, is empty.
 */
export function parseSdkModels(raw: unknown): readonly ModelChoice[] {
  if (!Array.isArray(raw)) return []
  const models: ModelChoice[] = []
  for (const entry of raw) {
    const parsed = modelInfo.safeParse(entry)
    if (!parsed.success || models.some((model) => model.id === parsed.data.value)) continue
    const info = parsed.data
    models.push({
      id: info.value,
      resolvedModel: info.resolvedModel ?? null,
      name: info.displayName,
      description: info.description?.trim() ?? '',
      efforts: effortsOf(info),
    })
  }
  return models
}
