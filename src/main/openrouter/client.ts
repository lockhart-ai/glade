import { z } from 'zod'
import type { OpenRouterModel, OpenRouterProvider, OpenRouterUsageReading } from '../../shared/openrouter'

interface KeyUsage {
  readonly free_model_daily_requests?: import('../../shared/openrouter').OpenRouterFreeRequests
  readonly usage: number
  readonly usage_daily: number
  readonly usage_weekly: number
  readonly usage_monthly: number
  readonly byok_usage: number
  readonly byok_usage_monthly: number
  readonly limit: number | null
  readonly limit_remaining: number | null
  readonly limit_reset: string | null
  readonly include_byok_in_limit: boolean
}
interface KeyUsageResponse {
  readonly data: KeyUsage
}
const keyUsageResponse = z.object({
  data: z.object({
    free_model_daily_requests: z
      .object({
        used: z.number().int().nonnegative(),
        limit: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative(),
      })
      .optional(),
    usage: z.number().nonnegative(),
    usage_daily: z.number().nonnegative(),
    usage_weekly: z.number().nonnegative(),
    usage_monthly: z.number().nonnegative(),
    byok_usage: z.number().nonnegative(),
    byok_usage_monthly: z.number().nonnegative(),
    limit: z.number().nonnegative().nullable(),
    limit_remaining: z.number().nullable(),
    limit_reset: z.string().nullable(),
    include_byok_in_limit: z.boolean(),
  }),
}) satisfies z.ZodType<KeyUsageResponse>

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

/** Providers by their name: the menus list them alphabetised (#566). */
export function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name.localeCompare(b.name)
}

/** Fetch is injectable; tests never send inference or catalog requests to an account. */
export class OpenRouterClient {
  constructor(private readonly request: typeof fetch) {}

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
      providers: providersResponse
        .parse(providers)
        .data.map(({ slug, name }) => ({ id: slug, name }))
        .sort(byName),
    }
  }

  async endpoints(
    key: string,
    model: string,
    providers: readonly OpenRouterProvider[],
  ): Promise<readonly OpenRouterProvider[]> {
    const path = model.split('/').map(encodeURIComponent).join('/')
    const data = endpointsResponse.parse(await this.get(key, `models/${path}/endpoints`)).data
    return providers
      .flatMap((provider) => {
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
      .sort(byName)
  }

  async providerModels(key: string, provider: OpenRouterProvider): Promise<readonly string[]> {
    return modelResponse
      .parse(await this.get(key, `models?providers=${encodeURIComponent(provider.name)}`))
      .data.map(({ id }) => id)
  }

  async usage(key: string, readAt: number): Promise<OpenRouterUsageReading> {
    const value = keyUsageResponse.parse(await this.get(key, 'key')).data
    return {
      ...(value.free_model_daily_requests === undefined ? {} : { freeRequests: value.free_model_daily_requests }),
      readAt,
      total: value.usage,
      daily: value.usage_daily,
      weekly: value.usage_weekly,
      monthly: value.usage_monthly,
      byokTotal: value.byok_usage,
      byokMonthly: value.byok_usage_monthly,
      limit: value.limit,
      remaining: value.limit_remaining,
      limitReset: value.limit_reset,
      includesByok: value.include_byok_in_limit,
    }
  }
}
