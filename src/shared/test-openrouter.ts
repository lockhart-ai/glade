import type { OpenRouterChoice, OpenRouterModel, OpenRouterProvider } from './openrouter'
import { openRouterChoiceId } from './openrouter'

export const SAMPLE_USAGE_RESPONSE = {
  data: {
    usage: 12.345678,
    usage_daily: 0.25,
    usage_weekly: 1.5,
    usage_monthly: 12,
    byok_usage: 2,
    byok_usage_monthly: 0.4,
    limit: 20,
    limit_remaining: 8,
    limit_reset: 'monthly',
    include_byok_in_limit: false,
  },
}
export const SAMPLE_USAGE: import('./openrouter').OpenRouterUsageReading = {
  readAt: 0,
  total: 12.345678,
  daily: 0.25,
  weekly: 1.5,
  monthly: 12,
  byokTotal: 2,
  byokMonthly: 0.4,
  limit: 20,
  remaining: 8,
  limitReset: 'monthly',
  includesByok: false,
}

export const SAMPLE_MODEL: OpenRouterModel = {
  id: 'sample/flash',
  name: 'Sample Flash',
  description: 'For routine work',
  contextLength: 128_000,
  inputs: ['text'],
  parameters: ['tools'],
  inputPrice: '0.0000001',
  outputPrice: '0.0000002',
}
export const SAMPLE_PROVIDER: OpenRouterProvider = { id: 'sample-host', name: 'Sample Host' }
export const SAMPLE_CHOICE: OpenRouterChoice = {
  id: openRouterChoiceId(SAMPLE_MODEL.id, SAMPLE_PROVIDER.id),
  model: SAMPLE_MODEL,
  provider: SAMPLE_PROVIDER,
  enabled: true,
}
export const SAMPLE_CATALOG_RESPONSE = {
  data: [
    {
      id: SAMPLE_MODEL.id,
      name: SAMPLE_MODEL.name,
      description: SAMPLE_MODEL.description,
      context_length: SAMPLE_MODEL.contextLength,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
      pricing: { prompt: SAMPLE_MODEL.inputPrice, completion: SAMPLE_MODEL.outputPrice },
    },
  ],
}
