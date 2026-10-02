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
  guessContextWindow,
  modelLabel,
  modelName,
  modelOptions,
  sameModel,
  type ModelChoice,
} from './models'
import { ALIAS_MODELS, HAIKU_MODEL, LITE_MODEL, OPUS_MODEL, SDK_MODELS, SONNET_MODEL } from './test-models'

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
  it('names a model the list has, by its id, its full id, or its full id without the date', () => {
    expect(modelName(SDK_MODELS, 'claude-haiku-4-5-20251001')).toBe('Haiku')
    expect(modelName(SDK_MODELS, 'claude-haiku-4-5')).toBe('Haiku')
    expect(modelName(BUILT_IN_MODELS, 'claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelName(BUILT_IN_MODELS, 'claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })

  // #416: a task on `opus[1m]` showed the raw id once the SDK's list stopped having it.
  it('names a 1M variant the list doesn’t have after its base model, with "(1M)"', () => {
    expect(modelName(ALIAS_MODELS, 'opus[1m]')).toBe('Opus 5.5 (1M)')
    expect(modelName(ALIAS_MODELS, 'sonnet[1m]')).toBe('Sonnet 5 (1M)')
    expect(modelName(ALIAS_MODELS, 'claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 (1M)')
    expect(modelName(ALIAS_MODELS, 'fable[1M]')).toBe('Fable (1M)')
    // After the model, not the default choice that stands for it too.
    expect(modelName(ALIAS_MODELS, 'claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)')
    expect(modelName(ALIAS_MODELS, 'default[1m]')).toBe('Default (recommended) (1M)')
    // The list's own name for it wins, and one that says 1M isn't told twice.
    expect(modelName(SDK_MODELS, 'opus[1m]')).toBe('Opus (1M context)')
  })

  it('spells out a full id the list doesn’t have, whichever way round it is, with or without a date', () => {
    expect(modelName(ALIAS_MODELS, 'claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelName(ALIAS_MODELS, 'claude-opus-5')).toBe('Opus 5')
    expect(modelName(ALIAS_MODELS, 'claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelName(ALIAS_MODELS, 'claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelName(ALIAS_MODELS, 'claude-3-7-sonnet')).toBe('Sonnet 3.7')
    expect(modelName(ALIAS_MODELS, 'claude-3-opus-20240229')).toBe('Opus 3')
    expect(modelName(SDK_MODELS, 'claude-retired-3')).toBe('Retired 3')
  })

  it('names an alias the list doesn’t have after the newest of its family, else in capitals', () => {
    // The built-in list has Opus 5.5 only as `claude-opus-5-5[1m]`.
    expect(modelName(BUILT_IN_MODELS, 'opus')).toBe('Opus 5.5')
    expect(modelName(BUILT_IN_MODELS, 'opus[1m]')).toBe('Opus 5.5 (1M)')
    expect(modelName(BUILT_IN_MODELS, 'haiku')).toBe('Haiku 4.5')
    expect(modelName(BUILT_IN_MODELS, 'fable')).toBe('Fable')
    expect(modelName([], 'opusplan')).toBe('Opusplan')
    // A row with no full id is looked up by its own id.
    expect(modelName([{ ...SONNET_MODEL, id: 'claude-sonnet-5', resolvedModel: null }], 'sonnet')).toBe('Sonnet 5')
  })

  it('shows the id only for one that’s neither a Claude id nor an alias', () => {
    expect(modelName(SDK_MODELS, 'us.acme.custom-model-v2:0')).toBe('us.acme.custom-model-v2:0')
    expect(modelName(SDK_MODELS, 'claude-')).toBe('claude-')
  })
})

describe('modelLabel', () => {
  // #416: a task showing "Opus 5.5" ran at 1M.
  it('adds "(1M)" for a task whose window is 1M, unless the name says so or it’s the default choice', () => {
    expect(modelLabel(ALIAS_MODELS, 'opus', 1_000_000)).toBe('Opus 5.5 (1M)')
    expect(modelLabel(ALIAS_MODELS, 'opus', 200_000)).toBe('Opus 5.5')
    expect(modelLabel(ALIAS_MODELS, 'opus[1m]', 1_000_000)).toBe('Opus 5.5 (1M)')
    expect(modelLabel(BUILT_IN_MODELS, 'claude-opus-5-5[1m]', 1_000_000)).toBe('Opus 5.5 (1M)')
    expect(modelLabel(SDK_MODELS, 'opus[1m]', 1_000_000)).toBe('Opus (1M context)')
    expect(modelLabel(SDK_MODELS, 'default', 1_000_000)).toBe('Default (recommended)')
    // A full id the list's default row stands for is the default choice too.
    expect(modelLabel(SDK_MODELS, 'claude-opus-5-5[1m]', 1_000_000)).toBe('Default (recommended)')
    expect(modelLabel(ALIAS_MODELS, 'sonnet', 2_000_000)).toBe('Sonnet 5 (1M)')
  })
})

describe('modelOptions', () => {
  const names = (models: readonly ModelChoice[], current: string, name?: string): string[] =>
    modelOptions(models, current, name).map((option) => `${option.id}=${option.name}`)

  it('offers the list as it is when the current model is in it, by id or full id', () => {
    const listed = ['default=Default (recommended)', 'opus=Opus 5.5', 'sonnet=Sonnet 5', 'haiku=Haiku 4.5']
    expect(names(ALIAS_MODELS, 'sonnet')).toEqual(listed)
    expect(names(ALIAS_MODELS, 'claude-sonnet-5')).toEqual(listed)
  })

  // #416: the picker's list didn't have the task's `opus[1m]` at all.
  it('always has the current model: a 1M variant right after its base model, anything else last', () => {
    expect(names(ALIAS_MODELS, 'opus[1m]')).toEqual([
      'default=Default (recommended)',
      'opus=Opus 5.5',
      'opus[1m]=Opus 5.5 (1M)',
      'sonnet=Sonnet 5',
      'haiku=Haiku 4.5',
    ])
    expect(names(ALIAS_MODELS, 'claude-opus-4-8').at(-1)).toBe('claude-opus-4-8=Opus 4.8')
    // A 1M variant whose base the list doesn't have either goes last too.
    expect(names(ALIAS_MODELS, 'fable[1m]').at(-1)).toBe('fable[1m]=Fable (1M)')
    expect(names([], 'opus[1m]')).toEqual(['opus[1m]=Opus (1M)'])
    // The name the caller shows for it is the one listed.
    expect(names(ALIAS_MODELS, 'claude-opus-4-8', 'Opus 4.8 (1M)').at(-1)).toBe('claude-opus-4-8=Opus 4.8 (1M)')
  })

  it('lists each 1M variant the SDK offers right after its base model, wherever the SDK put it', () => {
    const sonnet1m: ModelChoice = { ...SONNET_MODEL, id: 'sonnet[1m]', name: 'Sonnet (1M context)' }
    const fable1m: ModelChoice = { ...SONNET_MODEL, id: 'fable[1m]', resolvedModel: null, name: 'Fable (1M context)' }
    const opus: ModelChoice = { ...OPUS_MODEL, id: 'opus', resolvedModel: 'claude-opus-5-5', name: 'Opus' }
    expect(names([sonnet1m, OPUS_MODEL, fable1m, HAIKU_MODEL, opus, SONNET_MODEL], 'haiku')).toEqual([
      // No base in the list: it stays where the SDK put it.
      'fable[1m]=Fable (1M context)',
      'haiku=Haiku',
      'opus=Opus',
      'opus[1m]=Opus (1M context)',
      'sonnet=Sonnet',
      'sonnet[1m]=Sonnet (1M context)',
    ])
    // The SDK's own list keeps its order: `opus[1m]` has no base row there.
    expect(modelOptions(SDK_MODELS, 'lite').map(({ id }) => id)).toEqual(SDK_MODELS.map(({ id }) => id))
  })
})

describe('guessContextWindow', () => {
  const none = new Map<string, number>()

  it('takes what the SDK last reported for the model, by its id or the full id it stands for', () => {
    // #416: Opus 5.5 runs at 1M as plain `claude-opus-5-5`; only a report says so.
    expect(guessContextWindow(ALIAS_MODELS, none, 'opus')).toBe(200_000)
    expect(guessContextWindow(ALIAS_MODELS, new Map([['claude-opus-5-5', 1_000_000]]), 'opus')).toBe(1_000_000)
    expect(guessContextWindow(ALIAS_MODELS, new Map([['default', 1_000_000]]), 'claude-opus-5-5')).toBe(1_000_000)
    expect(guessContextWindow(ALIAS_MODELS, new Map([['opus', 1_000_000]]), 'sonnet')).toBe(200_000)
    // A report beats the suffix: a 1M variant the account runs at 200k.
    expect(guessContextWindow(SDK_MODELS, new Map([['opus[1m]', 200_000]]), 'opus[1m]')).toBe(200_000)
    expect(guessContextWindow([], new Map([['claude-custom', 500_000]]), 'claude-custom')).toBe(500_000)
  })

  it('else takes 1M from the suffix of the id or its full id, or from what the list says of the model', () => {
    expect(guessContextWindow([], none, 'opus[1m]')).toBe(1_000_000)
    expect(guessContextWindow([], none, 'claude-opus-5-5[1M]')).toBe(1_000_000)
    // `default` stands for `claude-opus-5-5[1m]`.
    expect(guessContextWindow(SDK_MODELS, none, 'default')).toBe(1_000_000)
    const described: ModelChoice = { ...SONNET_MODEL, description: 'Sonnet 5 with 1M context' }
    expect(guessContextWindow([described], none, 'sonnet')).toBe(1_000_000)
    expect(guessContextWindow([{ ...SONNET_MODEL, name: 'Sonnet (1M context)' }], none, 'sonnet')).toBe(1_000_000)
  })

  it('else takes the standard 200k', () => {
    expect(guessContextWindow(SDK_MODELS, none, 'sonnet')).toBe(200_000)
    expect(guessContextWindow(SDK_MODELS, none, 'claude-retired-3')).toBe(200_000)
    // "1M" has to be a word of its own.
    expect(guessContextWindow([{ ...SONNET_MODEL, name: 'Sonnet 51Mx' }], none, 'sonnet')).toBe(200_000)
  })
})

describe('sameModel', () => {
  it('holds for one id, one row, or two rows that stand for the same full id', () => {
    expect(sameModel(SDK_MODELS, 'sonnet', 'sonnet')).toBe(true)
    expect(sameModel(SDK_MODELS, 'sonnet', 'claude-sonnet-5')).toBe(true)
    expect(sameModel(SDK_MODELS, 'default', 'opus[1m]')).toBe(true)
    expect(sameModel(ALIAS_MODELS, 'default', 'opus')).toBe(true)
  })

  it('doesn’t for different models, or a 1M variant and its base', () => {
    expect(sameModel(SDK_MODELS, 'sonnet', 'haiku')).toBe(false)
    expect(sameModel(ALIAS_MODELS, 'opus', 'opus[1m]')).toBe(false)
    expect(sameModel([], 'claude-a-1', 'claude-b-1')).toBe(false)
    expect(sameModel([{ ...SONNET_MODEL, resolvedModel: null }], 'sonnet', 'claude-sonnet-5')).toBe(false)
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
