// The models the SDK offers (migration 31): the list the latest session reported, kept so the pickers offer it before
// any session runs, and offline.
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import { Effort } from '../../../shared/domain'
import type { ModelChoice } from '../../../shared/models'
import { Row } from './rows'

const efforts = z.array(z.enum(Effort)).readonly()

/** The models, in the SDK's order; none until a session first reports them. */
export function getSdkModels(db: Database): readonly ModelChoice[] {
  return db
    .prepare('SELECT id, resolved_model, name, description, efforts FROM sdk_models ORDER BY position')
    .all()
    .map((raw) => {
      const row = new Row('sdk_models', raw)
      return {
        id: row.text('id'),
        resolvedModel: row.nullableText('resolved_model'),
        name: row.text('name'),
        description: row.text('description'),
        efforts: efforts.parse(row.json('efforts')),
      }
    })
}

/** Stores `models` in place of the ones kept. */
export function setSdkModels(db: Database, models: readonly ModelChoice[]): void {
  const insert = db.prepare(
    'INSERT INTO sdk_models (position, id, resolved_model, name, description, efforts) VALUES (?, ?, ?, ?, ?, ?)',
  )
  db.transaction(() => {
    db.prepare('DELETE FROM sdk_models').run()
    models.forEach((model, position) => {
      insert.run(position, model.id, model.resolvedModel, model.name, model.description, JSON.stringify(model.efforts))
    })
  })()
}
