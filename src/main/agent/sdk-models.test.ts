import { describe, expect, it } from 'vitest'
import { Effort } from '../../shared/domain'
import { ALL_EFFORTS } from '../../shared/models'
import { parseSdkModels } from './sdk-models'
import { TEST_MODE_MODELS } from './test-mode-backend'

/** What `initializationResult().models` answered with in a real run (SDK 0.3.281, `docs/sdk-notes.md` §4), trimmed. */
const PROBED = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5 · Efficient for routine tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
]

describe('parseSdkModels', () => {
  it('reads what a real session reports, in its order, with each model’s own effort levels', () => {
    expect(parseSdkModels(PROBED)).toEqual([
      {
        id: 'default',
        resolvedModel: 'claude-opus-5-5[1m]',
        name: 'Default (recommended)',
        description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
        efforts: ALL_EFFORTS,
      },
      {
        id: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        name: 'Sonnet',
        description: 'Sonnet 5 · Efficient for routine tasks',
        efforts: ALL_EFFORTS,
      },
      // No effort at all: the SDK leaves both fields out.
      {
        id: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        name: 'Haiku',
        description: 'Haiku 4.5 · Fastest for quick answers',
        efforts: [],
      },
    ])
  })

  it('reads no models from anything but a list', () => {
    expect(parseSdkModels(undefined)).toEqual([])
    expect(parseSdkModels(null)).toEqual([])
    expect(parseSdkModels({ value: 'sonnet', displayName: 'Sonnet' })).toEqual([])
    expect(parseSdkModels([])).toEqual([])
  })

  it('leaves out an entry it can’t read, and keeps the rest', () => {
    const models = parseSdkModels([
      null,
      'sonnet',
      { displayName: 'No id' },
      { value: '  ', displayName: 'Blank id' },
      { value: 'nameless' },
      { value: 'opus', displayName: 7 },
      { value: 'haiku', displayName: 'Haiku' },
    ])

    expect(models).toEqual([{ id: 'haiku', resolvedModel: null, name: 'Haiku', description: '', efforts: [] }])
  })

  it('keeps the first of an id given twice', () => {
    const models = parseSdkModels([
      { value: 'sonnet', displayName: 'Sonnet' },
      { value: 'sonnet', displayName: 'Sonnet again' },
    ])

    expect(models.map(({ name }) => name)).toEqual(['Sonnet'])
  })

  it('orders the levels lowest first, and leaves out one Glade doesn’t know, not the model', () => {
    const [model] = parseSdkModels([
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        supportsEffort: true,
        supportedEffortLevels: ['max', 'turbo', 'low', 'high', 'low'],
      },
    ])

    expect(model?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max])
  })

  it('takes every level for a model that supports effort without listing them, and none for one that doesn’t', () => {
    const models = parseSdkModels([
      { value: 'opus', displayName: 'Opus', supportsEffort: true },
      { value: 'odd', displayName: 'Odd', supportsEffort: false, supportedEffortLevels: ['low'] },
      { value: 'unsaid', displayName: 'Unsaid', supportedEffortLevels: ['low'] },
    ])

    expect(models.map(({ efforts }) => efforts)).toEqual([ALL_EFFORTS, [], []])
  })

  it('trims the description, and reads a model with none', () => {
    const models = parseSdkModels([
      { value: 'sonnet', displayName: 'Sonnet', description: '  Efficient.  ' },
      { value: 'haiku', displayName: 'Haiku' },
    ])

    expect(models.map(({ description }) => description)).toEqual(['Efficient.', ''])
  })

  it('reads the test modes’ models, which aren’t the built-in ones', () => {
    expect(parseSdkModels(TEST_MODE_MODELS).map(({ id, efforts }) => ({ id, efforts }))).toEqual([
      { id: 'default', efforts: ALL_EFFORTS },
      { id: 'sonnet', efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
      { id: 'haiku', efforts: [] },
    ])
  })
})
