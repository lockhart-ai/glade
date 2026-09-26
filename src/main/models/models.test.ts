import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { Effort } from '../../shared/domain'
import { BUILT_IN_MODELS } from '../../shared/models'
import { openAppDatabase } from '../db/database'
import { getSdkModels, setSdkModels } from '../db/repositories/sdk-models'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { TEST_MODE_MODELS } from '../agent/test-mode-backend'
import { SDK_MODELS } from '../../shared/test-models'
import { effortWithModel, listModels, recordSdkModels } from './models'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-models-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The app's database in `dir`, as a launch opens it. */
function launch(): ReturnType<typeof openAppDatabase>['db'] {
  return openAppDatabase(dir).db
}

describe('the SDK models’ repository', () => {
  it('keeps the list in order, with each model’s levels, and replaces it whole', () => {
    const db = launch()
    expect(getSdkModels(db)).toEqual([])

    setSdkModels(db, SDK_MODELS)
    expect(getSdkModels(db)).toEqual(SDK_MODELS)

    setSdkModels(db, [...SDK_MODELS].reverse().slice(0, 2))
    expect(getSdkModels(db).map(({ id }) => id)).toEqual(['haiku', 'lite'])
    db.close()
  })

  it('refuses levels that aren’t efforts, as a row that doesn’t parse', () => {
    const db = launch()
    db.prepare(
      "INSERT INTO sdk_models (position, id, resolved_model, name, description, efforts) VALUES (0, 'x', NULL, 'X', '', '[\"turbo\"]')",
    ).run()
    expect(() => getSdkModels(db)).toThrow()
    db.close()
  })
})

describe('listModels', () => {
  it('offers the built-in models until a session reports the SDK’s, then those', () => {
    const db = launch()
    expect(listModels(db)).toBe(BUILT_IN_MODELS)

    setSdkModels(db, SDK_MODELS)

    expect(listModels(db)).toEqual(SDK_MODELS)
    db.close()
  })
})

describe('recordSdkModels', () => {
  it('keeps the models a session reports and tells the windows, and they survive a relaunch', () => {
    const db = launch()
    const events: GladeEvent[] = []
    const log = createMemoryLog(LogScope.Agent)

    recordSdkModels({ db, emit: (event) => events.push(event), log: log.logger }, TEST_MODE_MODELS)

    const models = listModels(db)
    expect(models.map(({ id }) => id)).toEqual(['default', 'sonnet', 'haiku'])
    expect(events).toEqual([{ type: EventType.ModelsChanged, models }])
    expect(log.withMessage('models changed')).toEqual([expect.objectContaining({ level: LogLevel.Info })])
    db.close()

    const relaunched = launch()
    expect(listModels(relaunched)).toEqual(models)
    relaunched.close()
  })

  it('tells no one when the list is the one it has', () => {
    const db = launch()
    const emit = vi.fn()
    recordSdkModels({ db, emit }, TEST_MODE_MODELS)

    recordSdkModels({ db, emit }, TEST_MODE_MODELS)

    expect(emit).toHaveBeenCalledOnce()
    db.close()
  })

  it('takes a model the SDK stops offering off the list', () => {
    const db = launch()
    const emit = vi.fn()
    recordSdkModels({ db, emit }, TEST_MODE_MODELS)

    recordSdkModels({ db, emit }, TEST_MODE_MODELS.slice(1))

    expect(listModels(db).map(({ id }) => id)).toEqual(['sonnet', 'haiku'])
    expect(emit).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('keeps what the pickers offer when the SDK reports nothing it can read, and logs it', () => {
    const db = launch()
    const emit = vi.fn()
    const log = createMemoryLog(LogScope.Agent)
    recordSdkModels({ db, emit }, TEST_MODE_MODELS)
    const before = listModels(db)

    recordSdkModels({ db, emit, log: log.logger }, [{ value: 'sonnet' }])
    recordSdkModels({ db, emit }, undefined)

    expect(listModels(db)).toEqual(before)
    expect(emit).toHaveBeenCalledOnce()
    expect(log.withMessage('the SDK reported no models Glade can read')).toEqual([
      expect.objectContaining({ level: LogLevel.Warn }),
    ])
    db.close()
  })
})

describe('effortWithModel', () => {
  it('leaves the effort alone when the model doesn’t change', () => {
    const db = launch()
    expect(effortWithModel(db, undefined, undefined, Effort.Max)).toBeUndefined()
    expect(effortWithModel(db, undefined, Effort.Low, Effort.Max)).toBe(Effort.Low)
    db.close()
  })

  it('fits the effort given, or else the current one, to the new model', () => {
    const db = launch()
    setSdkModels(db, SDK_MODELS)
    expect(effortWithModel(db, 'sonnet', undefined, Effort.Max)).toBe(Effort.High)
    expect(effortWithModel(db, 'sonnet', Effort.XHigh, Effort.Max)).toBe(Effort.XHigh)
    expect(effortWithModel(db, 'lite', Effort.Max, Effort.Low)).toBe(Effort.Low)
    expect(effortWithModel(db, 'haiku', undefined, Effort.Max)).toBe(Effort.Max)
    db.close()
  })
})
