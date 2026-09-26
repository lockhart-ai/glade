import { describe, expect, it } from 'vitest'
import { Effort } from './domain'
import {
  ALL_EFFORTS,
  BUILT_IN_MODELS,
  defaultEffortOf,
  EFFORT_NAMES,
  effortFallbackNotice,
  effortFor,
  effortsOf,
  findModel,
  modelName,
} from './models'
import { HAIKU_MODEL, LITE_MODEL, SDK_MODELS, SONNET_MODEL } from './test-models'

describe('the built-in models', () => {
  it('are the current Opus, Sonnet and Haiku, and only Haiku takes no effort', () => {
    expect(BUILT_IN_MODELS.map(({ name, efforts }) => [name, efforts])).toEqual([
      ['Opus 5.5', ALL_EFFORTS],
      ['Sonnet 5', ALL_EFFORTS],
      ['Haiku 4.5', []],
    ])
  })

  it('name every effort level, xhigh included', () => {
    expect(ALL_EFFORTS).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max])
    expect(ALL_EFFORTS.map((effort) => EFFORT_NAMES[effort])).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max'])
  })
})

describe('findModel', () => {
  it('finds a model by its id, else by the full id it stands for', () => {
    expect(findModel(SDK_MODELS, 'sonnet')).toBe(SONNET_MODEL)
    expect(findModel(SDK_MODELS, 'claude-sonnet-5')).toBe(SONNET_MODEL)
    // Two stand for the same model: the first.
    expect(findModel(SDK_MODELS, 'claude-opus-5-5[1m]')?.id).toBe('default')
    expect(findModel(SDK_MODELS, 'opus[1m]')?.id).toBe('opus[1m]')
  })

  it('finds nothing for a model the list doesn’t have', () => {
    expect(findModel(SDK_MODELS, 'claude-sonnet-4')).toBeUndefined()
    expect(findModel(BUILT_IN_MODELS, 'sonnet')).toBeUndefined()
  })
})

describe('modelName', () => {
  it('names a model the list has, and shows the id of one it doesn’t', () => {
    expect(modelName(SDK_MODELS, 'claude-haiku-4-5-20251001')).toBe('Haiku')
    expect(modelName(BUILT_IN_MODELS, 'claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelName(SDK_MODELS, 'claude-retired-3')).toBe('claude-retired-3')
  })
})

describe('effortsOf', () => {
  it('offers a model’s own levels, none for one that takes none, and every level for an unknown one', () => {
    expect(effortsOf(SDK_MODELS, 'sonnet')).toEqual(SONNET_MODEL.efforts)
    expect(effortsOf(SDK_MODELS, 'haiku')).toEqual([])
    expect(effortsOf(SDK_MODELS, 'claude-retired-3')).toEqual(ALL_EFFORTS)
  })
})

describe('defaultEffortOf', () => {
  it('is High where the model has it, else its lowest', () => {
    expect(defaultEffortOf(ALL_EFFORTS)).toBe(Effort.High)
    expect(defaultEffortOf(LITE_MODEL.efforts)).toBe(Effort.Low)
    expect(defaultEffortOf([Effort.Max])).toBe(Effort.Max)
    expect(defaultEffortOf([])).toBe(Effort.High)
  })
})

describe('effortFor', () => {
  it('keeps an effort the model supports', () => {
    expect(effortFor(SDK_MODELS, 'sonnet', Effort.XHigh)).toBe(Effort.XHigh)
    expect(effortFor(SDK_MODELS, 'default', Effort.Max)).toBe(Effort.Max)
  })

  it('falls back to the model’s default for one it doesn’t', () => {
    expect(effortFor(SDK_MODELS, 'sonnet', Effort.Max)).toBe(Effort.High)
    expect(effortFor(SDK_MODELS, 'lite', Effort.XHigh)).toBe(Effort.Low)
  })

  it('keeps the effort for a model that takes none, for the next model, and for one it doesn’t know', () => {
    expect(effortFor(SDK_MODELS, HAIKU_MODEL.id, Effort.Max)).toBe(Effort.Max)
    expect(effortFor(SDK_MODELS, 'claude-retired-3', Effort.Max)).toBe(Effort.Max)
  })
})

describe('effortFallbackNotice', () => {
  it('says the effort fell back, naming the model, the effort it had and the one it has now', () => {
    expect(effortFallbackNotice(SDK_MODELS, 'sonnet', Effort.Max, Effort.High)).toBe(
      'Sonnet doesn’t offer Max effort, so it’s now High.',
    )
    expect(effortFallbackNotice(SDK_MODELS, 'lite', Effort.XHigh, Effort.Low)).toBe(
      'Lite doesn’t offer Extra high effort, so it’s now Low.',
    )
  })

  it('says nothing when it didn’t', () => {
    expect(effortFallbackNotice(SDK_MODELS, 'sonnet', Effort.High, Effort.High)).toBeNull()
  })
})
