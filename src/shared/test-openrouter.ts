import type { OpenRouterChoice, OpenRouterModel, OpenRouterProvider } from './openrouter'
import { openRouterChoiceId } from './openrouter'

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
