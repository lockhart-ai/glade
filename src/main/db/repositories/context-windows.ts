// The context window the SDK last reported for each model (migration 51), and the guess at a model's window it informs
// before the model's session reports one (`guessContextWindow`, `docs/sdk-notes.md`, "Usage and context size").
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { guessContextWindow } from '../../../shared/models'
import { Row } from './rows'
import { offeredModels } from './sdk-models'
import { AgentSource, agentSource } from '../../../shared/openrouter'

/** The window the SDK last reported for each model, by every id it went by. */
export function getReportedWindows(db: Database): ReadonlyMap<string, number> {
  const rows = db.prepare('SELECT model, window_tokens FROM reported_context_windows').all()
  return new Map(
    rows.map((raw) => {
      const row = new Row('reported_context_windows', raw)
      return [row.text('model'), row.integer('window_tokens')]
    }),
  )
}

/** Remembers that the SDK reported a window of `windowTokens` for the model that went by each of `models`. */
export function recordReportedWindow(
  db: Database,
  models: readonly string[],
  windowTokens: number,
  now: EpochMs = Date.now(),
): void {
  const upsert = db.prepare(
    `INSERT INTO reported_context_windows (model, window_tokens, reported_at) VALUES (?, ?, ?)
      ON CONFLICT (model) DO UPDATE SET window_tokens = excluded.window_tokens, reported_at = excluded.reported_at`,
  )
  db.transaction(() => {
    for (const model of new Set(models)) upsert.run(model, windowTokens, now)
  })()
}

/**
 * The best guess at model `model`'s window before its session reports one, from the windows reported before and the
 * models the pickers offer (the SDK's, else the built-in ones).
 */
export function guessModelWindow(db: Database, model: string): number {
  return guessContextWindow(offeredModels(db), getReportedWindows(db), model)
}

/** OpenRouter native children share the SDK's context limit; use the smallest enabled route for compaction. */
export function taskModelWindow(db: Database, model: string): number {
  if (agentSource(model) !== AgentSource.OpenRouter) return guessModelWindow(db, model)
  const row = new Row(
    'openrouter_choices',
    db
      .prepare(
        "SELECT min(CAST(json_extract(choice, '$.model.contextLength') AS INTEGER)) AS window FROM openrouter_choices WHERE id = ? OR json_extract(choice, '$.enabled') = 1",
      )
      .get(model),
  )
  return row.nullableInteger('window') ?? guessModelWindow(db, model)
}
