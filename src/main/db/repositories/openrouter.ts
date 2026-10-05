import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import type {
  OpenRouterChoice,
  OpenRouterModel,
  OpenRouterProvider,
  OpenRouterStatus,
} from '../../../shared/openrouter'
import { openRouterChoiceSchema, openRouterModelSchema, openRouterProviderSchema } from '../../openrouter/schemas'
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
  db.prepare('INSERT OR REPLACE INTO openrouter_connection VALUES (1, ?, ?, ?)').run(
    connection.encryptedKey,
    JSON.stringify(connection.models),
    JSON.stringify(connection.providers),
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
