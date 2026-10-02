// Test helpers: a made-up list of models as the SDK reports them once parsed, for tests on both sides of the bridge. As
// a real login's list has, it names models by alias, two of them the same model, and Haiku takes no effort.
import { Effort } from './domain'
import { ALL_EFFORTS, type ModelChoice } from './models'

export const DEFAULT_MODEL: ModelChoice = {
  id: 'default',
  resolvedModel: 'claude-opus-5-5[1m]',
  name: 'Default (recommended)',
  description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
  efforts: ALL_EFFORTS,
}

export const OPUS_MODEL: ModelChoice = {
  id: 'opus[1m]',
  resolvedModel: 'claude-opus-5-5[1m]',
  name: 'Opus (1M context)',
  description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
  efforts: ALL_EFFORTS,
}

/** Sonnet, without the top level. */
export const SONNET_MODEL: ModelChoice = {
  id: 'sonnet',
  resolvedModel: 'claude-sonnet-5',
  name: 'Sonnet',
  description: 'Sonnet 5 · Efficient for routine tasks',
  efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
}

/** Only the lower levels: no High to fall back to. */
export const LITE_MODEL: ModelChoice = {
  id: 'lite',
  resolvedModel: 'claude-lite-1',
  name: 'Lite',
  description: '',
  efforts: [Effort.Low, Effort.Medium],
}

export const HAIKU_MODEL: ModelChoice = {
  id: 'haiku',
  resolvedModel: 'claude-haiku-4-5-20251001',
  name: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
  efforts: [],
}

export const SDK_MODELS: readonly ModelChoice[] = [DEFAULT_MODEL, OPUS_MODEL, SONNET_MODEL, LITE_MODEL, HAIKU_MODEL]

/**
 * A list as a login whose 1M models don't say so reports it (#416): bare aliases, with the version in the name, and no
 * `[1m]` on any id or full id. Opus 5.5 runs at 1M all the same.
 */
export const ALIAS_MODELS: readonly ModelChoice[] = [
  {
    id: 'default',
    resolvedModel: 'claude-opus-5-5',
    name: 'Default (recommended)',
    description: 'Use the default model (currently Opus 5.5)',
    efforts: ALL_EFFORTS,
  },
  {
    id: 'opus',
    resolvedModel: 'claude-opus-5-5',
    name: 'Opus 5.5',
    description: 'Most capable for your hardest and longest-running tasks',
    efforts: ALL_EFFORTS,
  },
  {
    id: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    name: 'Sonnet 5',
    description: 'Efficient for routine tasks',
    efforts: ALL_EFFORTS,
  },
  {
    id: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    name: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    efforts: [],
  },
]
