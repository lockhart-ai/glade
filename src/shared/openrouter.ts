/** Billing source of an inference session. Native SDK children share their parent's source. */
export enum AgentSource {
  Anthropic = 'anthropic',
  OpenRouter = 'openrouter',
}

export interface OpenRouterProvider {
  readonly id: string
  readonly name: string
  /** Model-specific endpoint metadata, present after endpoint discovery. */
  readonly inputPrice?: string
  readonly outputPrice?: string
  readonly contextLength?: number
  readonly parameters?: readonly string[]
}

export interface OpenRouterModel {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly contextLength: number
  readonly inputs: readonly string[]
  readonly parameters: readonly string[]
  readonly inputPrice: string
  readonly outputPrice: string
}

/** An immutable model/provider pair. Changing provider creates a different choice. */
export interface OpenRouterChoice {
  readonly id: string
  readonly model: OpenRouterModel
  readonly provider: OpenRouterProvider
  readonly enabled: boolean
}

export interface OpenRouterStatus {
  readonly connected: boolean
  readonly models: readonly OpenRouterModel[]
  readonly providers: readonly OpenRouterProvider[]
  readonly choices: readonly OpenRouterChoice[]
}

export interface OpenRouterConnectRequest {
  readonly key: string
}

export interface OpenRouterEndpointsRequest {
  readonly model: string
}

export interface OpenRouterChoiceRequest {
  readonly model: string
  readonly provider: string
  readonly enabled: boolean
}

export interface OpenRouterProviderModelsRequest {
  readonly provider: string
}

export interface OpenRouterActions {
  status(): Promise<OpenRouterStatus>
  connect(key: string): Promise<OpenRouterStatus>
  refresh(): Promise<OpenRouterStatus>
  remove(): Promise<OpenRouterStatus>
  endpoints(model: string): Promise<readonly OpenRouterProvider[]>
  select(choice: OpenRouterChoiceRequest): Promise<OpenRouterStatus>
  providerModels(provider: string): Promise<readonly string[]>
}

export const OPENROUTER_PREFIX = 'openrouter:'

export function agentSource(model: string): AgentSource {
  return model.startsWith(OPENROUTER_PREFIX) ? AgentSource.OpenRouter : AgentSource.Anthropic
}

export function openRouterChoiceId(model: string, provider: string): string {
  return `${OPENROUTER_PREFIX}${model}@${provider}`
}
