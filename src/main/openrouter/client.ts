import { z } from 'zod'
import type { OpenRouterModel, OpenRouterProvider } from '../../shared/openrouter'

interface ModelArchitecture {
  readonly input_modalities: readonly string[]
  readonly output_modalities: readonly string[]
}
interface ModelPricing {
  readonly prompt: string
  readonly completion: string
}
interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly context_length: number
  readonly architecture: ModelArchitecture
  readonly supported_parameters: readonly string[]
  readonly pricing: ModelPricing
}
interface ModelsResponse {
  readonly data: readonly CatalogModel[]
}
interface CatalogProvider {
  readonly slug: string
  readonly name: string
}
interface ProvidersResponse {
  readonly data: readonly CatalogProvider[]
}
interface CatalogEndpoint {
  readonly provider_name: string
  readonly tag: string
  readonly supported_parameters: readonly string[]
  readonly context_length?: number
  readonly pricing?: ModelPricing
}
interface ModelEndpoints {
  readonly endpoints: readonly CatalogEndpoint[]
}
interface EndpointsResponse {
  readonly data: ModelEndpoints
}

const modelResponse = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      description: z.string().default(''),
      context_length: z.number().int().positive(),
      architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
      supported_parameters: z.array(z.string()).default([]),
      pricing: z.object({ prompt: z.string(), completion: z.string() }),
    }),
  ),
}) satisfies z.ZodType<ModelsResponse>
const providersResponse = z.object({
  data: z.array(z.object({ slug: z.string().min(1), name: z.string() })),
}) satisfies z.ZodType<ProvidersResponse>
const endpointsResponse = z.object({
  data: z.object({
    endpoints: z.array(
      z.object({
        provider_name: z.string(),
        tag: z.string(),
        supported_parameters: z.array(z.string()).default([]),
        context_length: z.number().int().positive().optional(),
        pricing: z.object({ prompt: z.string(), completion: z.string() }).optional(),
      }),
    ),
  }),
}) satisfies z.ZodType<EndpointsResponse>

export interface OpenRouterCatalog {
  readonly models: readonly OpenRouterModel[]
  readonly providers: readonly OpenRouterProvider[]
}

/** Fetch is injectable; tests never send inference or catalog requests to an account. */
export class OpenRouterClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async get(key: string, path: string): Promise<unknown> {
    const response = await this.request(`https://openrouter.ai/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    })
    if (!response.ok)
      throw new Error(`OpenRouter returned ${String(response.status)}. Check the key and its restrictions.`)
    return response.json()
  }

  async catalog(key: string): Promise<OpenRouterCatalog> {
    const [models, providers] = await Promise.all([this.get(key, 'models/user'), this.get(key, 'providers')])
    return {
      models: modelResponse
        .parse(models)
        .data.filter(
          (model) =>
            model.architecture.input_modalities.includes('text') &&
            model.architecture.output_modalities.includes('text') &&
            model.supported_parameters.includes('tools'),
        )
        .map((model) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          contextLength: model.context_length,
          inputs: model.architecture.input_modalities,
          parameters: model.supported_parameters,
          inputPrice: model.pricing.prompt,
          outputPrice: model.pricing.completion,
        })),
      providers: providersResponse.parse(providers).data.map(({ slug, name }) => ({ id: slug, name })),
    }
  }

  async endpoints(
    key: string,
    model: string,
    providers: readonly OpenRouterProvider[],
  ): Promise<readonly OpenRouterProvider[]> {
    const path = model.split('/').map(encodeURIComponent).join('/')
    const data = endpointsResponse.parse(await this.get(key, `models/${path}/endpoints`)).data
    return providers.flatMap((provider) => {
      const endpoint = data.endpoints.find(
        (endpoint) => endpoint.supported_parameters.includes('tools') && endpoint.tag.split('/')[0] === provider.id,
      )
      if (endpoint === undefined) return []
      return [
        {
          ...provider,
          ...(endpoint.pricing === undefined
            ? {}
            : { inputPrice: endpoint.pricing.prompt, outputPrice: endpoint.pricing.completion }),
          ...(endpoint.context_length === undefined ? {} : { contextLength: endpoint.context_length }),
          parameters: endpoint.supported_parameters,
        },
      ]
    })
  }

  async providerModels(key: string, provider: OpenRouterProvider): Promise<readonly string[]> {
    return modelResponse
      .parse(await this.get(key, `models?providers=${encodeURIComponent(provider.name)}`))
      .data.map(({ id }) => id)
  }

  async generation(key: string, id: string): Promise<OpenRouterGenerationMetadata> {
    return generationResponse.parse(await this.get(key, `generation?id=${encodeURIComponent(id)}`)).data
  }
}

export interface OpenRouterGenerationMetadata {
  readonly id: string
  readonly total_cost: number
  readonly provider_name: string
}

interface OpenRouterGenerationResponse {
  readonly data: OpenRouterGenerationMetadata
}

const generationResponse = z.object({
  data: z.object({ id: z.string(), total_cost: z.number().nonnegative(), provider_name: z.string() }),
}) satisfies z.ZodType<OpenRouterGenerationResponse>
