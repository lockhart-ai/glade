import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { EventType } from '../../shared/bridge'
import {
  openRouterChoiceId,
  type OpenRouterChoice,
  type OpenRouterChoiceRequest,
  type OpenRouterProvider,
  type OpenRouterStatus,
} from '../../shared/openrouter'
import type { Emit } from '../bridge/events'
import {
  getOpenRouterChoices,
  getOpenRouterConnection,
  openRouterStatus,
  setOpenRouterChoice,
  setOpenRouterConnection,
} from '../db/repositories/openrouter'
import { listModels } from '../models/models'
import { recordReportedWindow } from '../db/repositories/context-windows'
import { OpenRouterClient } from './client'

export interface CredentialCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface OpenRouterServiceOptions {
  readonly db: Database
  readonly emit: Emit
  readonly cipher: CredentialCipher
  readonly client?: OpenRouterClient
}

export interface OpenRouterGeneration {
  readonly id: string
  readonly choiceId: string
  readonly taskId: string | null
}

/** Only main owns this service. The bridge exposes status and catalog, never the decrypted key. */
export class OpenRouterService {
  private readonly client: OpenRouterClient
  private revision = 0
  constructor(private readonly options: OpenRouterServiceOptions) {
    this.client = options.client ?? new OpenRouterClient()
  }

  status(): OpenRouterStatus {
    return openRouterStatus(this.options.db)
  }

  key(): string {
    const connection = getOpenRouterConnection(this.options.db)
    if (connection === null) throw new Error('Connect an OpenRouter key in Settings → Models.')
    return this.options.cipher.decryptString(connection.encryptedKey)
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
    this.options.db.prepare('DELETE FROM openrouter_connection').run()
    return this.changed()
  }

  async endpoints(model: string): Promise<readonly OpenRouterProvider[]> {
    const status = this.status()
    if (!status.models.some(({ id }) => id === model))
      throw new Error('This model is not available to the OpenRouter key.')
    return this.client.endpoints(this.key(), model, status.providers)
  }

  async select(request: OpenRouterChoiceRequest): Promise<OpenRouterStatus> {
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
    })()
    return this.changed()
  }

  async providerModels(id: string): Promise<readonly string[]> {
    const status = this.status()
    const provider = status.providers.find((provider) => provider.id === id)
    if (provider === undefined) throw new Error('This provider is not in the OpenRouter catalog.')
    const models = new Set(await this.client.providerModels(this.key(), provider))
    return status.models.filter(({ id }) => models.has(id)).map(({ id }) => id)
  }

  recordGeneration(generation: OpenRouterGeneration): void {
    if (!this.options.db.open) return
    this.options.db
      .prepare('INSERT OR IGNORE INTO openrouter_generations (id, task_id, choice_id) VALUES (?, ?, ?)')
      .run(generation.id, generation.taskId, generation.choiceId)
  }

  /** Delayed metadata stays pending in SQLite for the next request or launch. */
  async reconcileGenerations(): Promise<void> {
    const { db } = this.options
    if (!db.open || getOpenRouterConnection(db) === null) return
    const pending = db.prepare('SELECT id FROM openrouter_generations WHERE cost_usd IS NULL').all()
    for (const raw of pending) {
      const id = z.object({ id: z.string() }).parse(raw).id
      try {
        const metadata = await this.client.generation(this.key(), id)
        if (this.options.db.open && metadata.id === id)
          db.prepare('UPDATE openrouter_generations SET actual_provider = ?, cost_usd = ? WHERE id = ?').run(
            metadata.provider_name,
            metadata.total_cost,
            id,
          )
      } catch {
        // Metadata may lag a completed stream. Never substitute SDK list-price estimates.
      }
    }
  }
}
