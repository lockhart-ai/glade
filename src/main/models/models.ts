// The models the pickers offer (`docs/sdk-notes.md` §4): the SDK's list, as the latest session reported it and SQLite
// keeps it, or the built-in one until a session first has.
import type { Database } from 'better-sqlite3'
import { EventType } from '../../shared/bridge'
import type { Effort } from '../../shared/domain'
import { BUILT_IN_MODELS, effortFor, type ModelChoice } from '../../shared/models'
import { parseSdkModels } from '../agent/sdk-models'
import type { Emit } from '../bridge/events'
import { getSdkModels, setSdkModels } from '../db/repositories/sdk-models'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

/** The models the pickers offer: the SDK's, once a session has reported them, else the built-in ones. */
export function listModels(db: Database): readonly ModelChoice[] {
  const stored = getSdkModels(db)
  return stored.length > 0 ? stored : BUILT_IN_MODELS
}

/** What recording the SDK's models needs: where to keep them, and whom to tell. */
export interface ModelsContext {
  readonly db: Database
  readonly emit: Emit
  readonly log?: Logger
}

function sameModels(a: readonly ModelChoice[], b: readonly ModelChoice[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Keeps the models a session's SDK reported (`initializationResult().models`, unparsed) in place of the ones kept, and
 * tells every window with `models.changed` when they differ. A report with no model Glade can read changes nothing:
 * the pickers keep offering what they did.
 */
export function recordSdkModels({ db, emit, log = SILENT_LOGGER }: ModelsContext, raw: unknown): void {
  const models = parseSdkModels(raw)
  if (models.length === 0) {
    log.warn('the SDK reported no models Glade can read', { models: raw })
    return
  }
  if (sameModels(models, getSdkModels(db))) return
  setSdkModels(db, models)
  log.info('models changed', { models: models.map(({ id, efforts }) => ({ id, efforts })) })
  emit({ type: EventType.ModelsChanged, models })
}

/**
 * The effort to write along with a change to model `model`: the one given, or else `current`, fitted to the model
 * (`effortFor`: its default when the model doesn't support it). `effort` itself when the model doesn't change.
 */
export function effortWithModel(
  db: Database,
  model: string | undefined,
  effort: Effort | undefined,
  current: Effort,
): Effort | undefined {
  if (model === undefined) return effort
  return effortFor(listModels(db), model, effort ?? current)
}
