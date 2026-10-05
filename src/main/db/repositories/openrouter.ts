import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import type {
  OpenRouterChoice,
  OpenRouterModel,
  OpenRouterProvider,
  OpenRouterStatus,
  OpenRouterUsageStatus,
} from '../../../shared/openrouter'
import {
  openRouterChoiceSchema,
  openRouterModelSchema,
  openRouterProviderSchema,
  openRouterUsageReadingSchema,
} from '../../openrouter/schemas'
import { Row } from './rows'

export interface OpenRouterConnection {
  readonly encryptedKey: Buffer
  readonly models: readonly OpenRouterModel[]
  readonly providers: readonly OpenRouterProvider[]
}

export function getOpenRouterConnection(db: Database): OpenRouterConnection | null {
  const raw = db.prepare('SELECT encrypted_key, models, providers FROM openrouter_connection WHERE id = 1').get()
  if (raw === undefined) return null
  const row = new Row('openrouter_connection', raw)
  return {
    encryptedKey: row.blob('encrypted_key'),
    models: z.array(openRouterModelSchema).parse(row.json('models')),
    providers: z.array(openRouterProviderSchema).parse(row.json('providers')),
  }
}

export function setOpenRouterConnection(db: Database, connection: OpenRouterConnection): void {
  db.prepare(
    `INSERT INTO openrouter_connection VALUES (1, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET encrypted_key = excluded.encrypted_key, models = excluded.models, providers = excluded.providers`,
  ).run(connection.encryptedKey, JSON.stringify(connection.models), JSON.stringify(connection.providers))
}

/** Credential and existence reads don't parse the catalog on the task/runner path. */
export function openRouterConnected(db: Database): boolean {
  return db.prepare('SELECT 1 FROM openrouter_connection WHERE id = 1').get() !== undefined
}

export function openRouterEncryptedKey(db: Database): Buffer | null {
  const raw = db.prepare('SELECT encrypted_key FROM openrouter_connection WHERE id = 1').get()
  return raw === undefined ? null : new Row('openrouter_connection', raw).blob('encrypted_key')
}

export function openRouterUsage(db: Database): OpenRouterUsageStatus {
  const raw = db.prepare('SELECT reading, error FROM openrouter_usage WHERE id = 1').get()
  if (raw === undefined) return { connected: openRouterConnected(db), reading: null, error: null }
  const row = new Row('openrouter_usage', raw)
  const reading = row.nullableText('reading') === null ? null : row.json('reading')
  return {
    connected: true,
    reading: reading === null ? null : openRouterUsageReadingSchema.parse(reading),
    error: row.nullableText('error'),
  }
}

export function setOpenRouterUsage(db: Database, status: OpenRouterUsageStatus): void {
  db.prepare('INSERT OR REPLACE INTO openrouter_usage VALUES (1, ?, ?)').run(
    status.reading === null ? null : JSON.stringify(status.reading),
    status.error,
  )
}

export function getOpenRouterChoices(db: Database): readonly OpenRouterChoice[] {
  return db
    .prepare('SELECT choice FROM openrouter_choices ORDER BY rowid')
    .all()
    .map((raw) => openRouterChoiceSchema.parse(new Row('openrouter_choices', raw).json('choice')))
}

export function getOpenRouterChoice(db: Database, id: string): OpenRouterChoice | undefined {
  const raw = db.prepare('SELECT choice FROM openrouter_choices WHERE id = ?').get(id)
  return raw === undefined ? undefined : openRouterChoiceSchema.parse(new Row('openrouter_choices', raw).json('choice'))
}

export function setOpenRouterChoice(db: Database, choice: OpenRouterChoice): void {
  db.prepare('INSERT OR REPLACE INTO openrouter_choices VALUES (?, ?)').run(choice.id, JSON.stringify(choice))
}

export function openRouterStatus(db: Database): OpenRouterStatus {
  const connection = getOpenRouterConnection(db)
  return {
    connected: connection !== null,
    models: connection?.models ?? [],
    providers: connection?.providers ?? [],
    choices: getOpenRouterChoices(db),
  }
}
