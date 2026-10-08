/** Billing source of one SDK session. Independently dispatched children choose their own source. */
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

/** Spend reported by /key, in USD. These figures cover all use of this key, including outside Glade. */
export interface OpenRouterFreeRequests {
  readonly used: number
  readonly limit: number
  readonly remaining: number
}
export interface OpenRouterUsageReading {
  readonly freeRequests?: OpenRouterFreeRequests
  readonly readAt: number
  readonly total: number
  readonly daily: number
  readonly weekly: number
  readonly monthly: number
  readonly byokTotal: number
  readonly byokMonthly: number
  readonly limit: number | null
  readonly remaining: number | null
  readonly limitReset: string | null
  readonly includesByok: boolean
}

export interface OpenRouterUsageStatus {
  readonly connected: boolean
  readonly reading: OpenRouterUsageReading | null
  readonly error: string | null
}
export interface OpenRouterUsageRefreshRequest {
  readonly force: boolean
}

export const EMPTY_OPENROUTER_USAGE: OpenRouterUsageStatus = { connected: false, reading: null, error: null }

export interface OpenRouterStatus {
  readonly connected: boolean
  /** Whether an OpenRouter management key is connected beside the inference key (#566). */
  readonly managementConnected: boolean
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
export interface OpenRouterSelection {
  readonly choices: readonly OpenRouterChoice[]
}

export interface OpenRouterProviderModelsRequest {
  readonly provider: string
}

export interface OpenRouterActions {
  readonly refreshUsage: (force?: boolean) => Promise<OpenRouterUsageStatus>
  status(): Promise<OpenRouterStatus>
  connect(key: string): Promise<OpenRouterStatus>
  refresh(): Promise<OpenRouterStatus>
  remove(): Promise<OpenRouterStatus>
  /** Connects the optional management key, reading the account's guardrails (#566). */
  connectManagementKey(key: string): Promise<OpenRouterStatus>
  removeManagementKey(): Promise<OpenRouterStatus>
  endpoints(model: string): Promise<readonly OpenRouterProvider[]>
  select(choice: OpenRouterChoiceRequest): Promise<OpenRouterSelection>
  providerModels(provider: string): Promise<readonly string[]>
}

export const OPENROUTER_PREFIX = 'openrouter:'

export function agentSource(model: string): AgentSource {
  return model.startsWith(OPENROUTER_PREFIX) ? AgentSource.OpenRouter : AgentSource.Anthropic
}

export function openRouterChoiceId(model: string, provider: string): string {
  return `${OPENROUTER_PREFIX}${model}@${provider}`
}
