import type { Database } from 'better-sqlite3'
import { EventType } from '../../shared/bridge'
import {
  openRouterChoiceId,
  type OpenRouterChoice,
  type OpenRouterChoiceRequest,
  type OpenRouterProvider,
  type OpenRouterStatus,
  type OpenRouterSelection,
  type OpenRouterUsageStatus,
  EMPTY_OPENROUTER_USAGE,
  AgentSource,
  agentSource,
} from '../../shared/openrouter'
import type { Emit } from '../bridge/events'
import {
  getOpenRouterChoices,
  getOpenRouterConnection,
  openRouterStatus,
  setOpenRouterChoice,
  setOpenRouterConnection,
  openRouterEncryptedKey,
  openRouterUsage,
  setOpenRouterUsage,
} from '../db/repositories/openrouter'
import { listModels } from '../models/models'
import { recordReportedWindow } from '../db/repositories/context-windows'
import { OpenRouterClient } from './client'
import { getSettings, updateSettings } from '../db/repositories/settings'
import { DEFAULT_SETTINGS } from '../../shared/settings'

export interface CredentialCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface OpenRouterServiceOptions {
  readonly db: Database
  readonly emit: Emit
  readonly cipher: CredentialCipher
  readonly client: OpenRouterClient
  readonly now?: () => number
}

/** Only main owns this service. The bridge exposes status and catalog, never the decrypted key. */
export class OpenRouterService {
  private readonly client: OpenRouterClient
  private revision = 0
  private usagePending: Promise<OpenRouterUsageStatus> | null = null
  private lastUsageAttempt = -Infinity
  private usageTimer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly options: OpenRouterServiceOptions) {
    this.client = options.client
  }

  status(): OpenRouterStatus {
    return openRouterStatus(this.options.db)
  }

  key(): string {
    const encrypted = openRouterEncryptedKey(this.options.db)
    if (encrypted === null) throw new Error('Connect an OpenRouter key in Settings → Models.')
    return this.options.cipher.decryptString(encrypted)
  }

  private changed(): OpenRouterStatus {
    this.options.emit({ type: EventType.ModelsChanged, models: listModels(this.options.db) })
    return this.status()
  }

  async connect(key: string): Promise<OpenRouterStatus> {
    if (!this.options.cipher.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.')
    const revision = ++this.revision
    const catalog = await this.client.catalog(key)
    if (revision !== this.revision) throw new Error('The OpenRouter connection changed. Connect again.')
    setOpenRouterConnection(this.options.db, { encryptedKey: this.options.cipher.encryptString(key), ...catalog })
    this.options.db.prepare('DELETE FROM openrouter_usage').run()
    this.usagePending = null
    this.clearUsageTimer()
    await this.refreshUsage(true)
    return this.changed()
  }

  async refresh(): Promise<OpenRouterStatus> {
    const key = this.key()
    const connection = getOpenRouterConnection(this.options.db)
    const catalog = await this.client.catalog(key)
    // A removal/replacement while discovery is in flight must not restore a removed key.
    if (!connection?.encryptedKey.equals(getOpenRouterConnection(this.options.db)?.encryptedKey ?? Buffer.alloc(0))) {
      throw new Error('The OpenRouter connection changed. Refresh again.')
    }
    setOpenRouterConnection(this.options.db, { encryptedKey: connection.encryptedKey, ...catalog })
    return this.changed()
  }

  remove(): OpenRouterStatus {
    this.revision++
    this.clearUsageTimer()
    this.usagePending = null
    this.options.db.transaction(() => {
      this.options.db.prepare('DELETE FROM openrouter_connection').run()
      this.repairDefaults()
    })()
    this.emitUsage()
    return this.changed()
  }

  async endpoints(model: string): Promise<readonly OpenRouterProvider[]> {
    const status = this.status()
    if (!status.models.some(({ id }) => id === model))
      throw new Error('This model is not available to the OpenRouter key.')
    return this.client.endpoints(this.key(), model, status.providers)
  }

  async select(request: OpenRouterChoiceRequest): Promise<OpenRouterSelection> {
    const revision = this.revision
    const model = this.status().models.find(({ id }) => id === request.model)
    if (model === undefined) throw new Error('This model is not available to the OpenRouter key.')
    const provider = (await this.endpoints(model.id)).find(({ id }) => id === request.provider)
    if (revision !== this.revision) throw new Error('The OpenRouter connection changed. Select the model again.')
    if (provider === undefined) throw new Error('This provider has no tool-capable endpoint for this model.')
    const choice: OpenRouterChoice = {
      id: openRouterChoiceId(model.id, provider.id),
      model: {
        ...model,
        contextLength: provider.contextLength ?? model.contextLength,
        parameters: provider.parameters ?? model.parameters,
        inputPrice: provider.inputPrice ?? model.inputPrice,
        outputPrice: provider.outputPrice ?? model.outputPrice,
      },
      provider,
      enabled: request.enabled,
    }
    this.options.db.transaction(() => {
      if (choice.enabled) {
        for (const old of getOpenRouterChoices(this.options.db)) {
          if (old.model.id === model.id && old.id !== choice.id && old.enabled)
            setOpenRouterChoice(this.options.db, { ...old, enabled: false })
        }
      }
      setOpenRouterChoice(this.options.db, choice)
      recordReportedWindow(this.options.db, [choice.id], choice.model.contextLength)
      this.repairDefaults()
    })()
    this.options.emit({ type: EventType.ModelsChanged, models: listModels(this.options.db) })
    return { choices: getOpenRouterChoices(this.options.db) }
  }

  async providerModels(id: string): Promise<readonly string[]> {
    const status = this.status()
    const provider = status.providers.find((provider) => provider.id === id)
    if (provider === undefined) throw new Error('This provider is not in the OpenRouter catalog.')
    const models = new Set(await this.client.providerModels(this.key(), provider))
    return status.models.filter(({ id }) => models.has(id)).map(({ id }) => id)
  }

  /** Removing a route must leave New task usable in every workspace. Existing tasks retain their saved route. */
  private repairDefaults(): void {
    const { db } = this.options
    const settings = getSettings(db)
    const available = new Set(listModels(db).map(({ id }) => id))
    const parentGone =
      agentSource(settings.defaultModel) === AgentSource.OpenRouter && !available.has(settings.defaultModel)
    if (!parentGone) return
    const updated = updateSettings(db, {
      defaultModel: DEFAULT_SETTINGS.defaultModel,
      defaultEffort: DEFAULT_SETTINGS.defaultEffort,
    })
    this.options.emit({ type: EventType.SettingsChanged, settings: updated })
  }

  usage(): OpenRouterUsageStatus {
    return this.options.db.open ? openRouterUsage(this.options.db) : EMPTY_OPENROUTER_USAGE
  }

  private emitUsage(): OpenRouterUsageStatus {
    const status = this.usage()
    this.options.emit({ type: EventType.OpenRouterUsageChanged, status })
    return status
  }

  private clearUsageTimer(): void {
    if (this.usageTimer !== null) clearTimeout(this.usageTimer)
    this.usageTimer = null
  }

  close(): void {
    this.revision++
    this.clearUsageTimer()
  }

  /** Keep a provider's credit failure visible until an inference request succeeds, even when /key still works. */
  noteResponse(status: number): void {
    const current = this.usage()
    if (!current.connected) return
    const blocked = 'OpenRouter requests are blocked: insufficient credits or the key spending limit was reached.'
    if (status === 402 || (status >= 200 && status < 300 && current.error === blocked)) {
      setOpenRouterUsage(this.options.db, { ...current, error: status === 402 ? blocked : null })
      this.emitUsage()
    }
  }

  /** Coalesce request completions, retaining a trailing read so the final request is included. */
  refreshUsage(force = false): Promise<OpenRouterUsageStatus> {
    const status = this.usage()
    if (!status.connected) return Promise.resolve(status)
    const now = this.options.now ?? Date.now
    const remaining = this.lastUsageAttempt + 60_000 - now()
    if (this.usagePending !== null || (!force && remaining > 0)) {
      if (!force && this.usageTimer === null) {
        this.usageTimer = setTimeout(
          () => {
            this.usageTimer = null
            void this.refreshUsage()
          },
          Math.max(1, remaining),
        )
        this.usageTimer.unref()
      }
      return this.usagePending ?? Promise.resolve(status)
    }
    this.clearUsageTimer()
    this.lastUsageAttempt = now()
    const revision = this.revision
    // Decryption is inside the promise too: an unavailable key must not throw during app launch.
    const read = async () => this.client.usage(this.key(), now())
    const pending = read()
      .then(
        (reading): OpenRouterUsageStatus => ({
          connected: true,
          reading,
          error:
            this.usage().error?.startsWith('OpenRouter requests are blocked:') === true ? this.usage().error : null,
        }),
        (): OpenRouterUsageStatus => ({
          ...status,
          error:
            this.usage().error?.startsWith('OpenRouter requests are blocked:') === true
              ? this.usage().error
              : 'Could not refresh OpenRouter usage. Showing the last reading.',
        }),
      )
      .then((next) => {
        if (!this.options.db.open || revision !== this.revision) return this.usage()
        setOpenRouterUsage(this.options.db, next)
        return this.emitUsage()
      })
      .finally(() => {
        if (this.usagePending === pending) this.usagePending = null
      })
    this.usagePending = pending
    return pending
  }
}
