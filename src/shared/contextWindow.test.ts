import { describe, expect, it } from 'vitest'
import {
  autoCompactThreshold,
  contextWindowFor,
  EXTENDED_CONTEXT_WINDOW,
  fitContextWindow,
  isExtendedId,
  matchReportedWindow,
  mentionsExtended,
  withoutExtended,
  STANDARD_CONTEXT_WINDOW,
} from './contextWindow'

it('gives the 1M-context variants a 1M window', () => {
  expect(contextWindowFor('claude-opus-5-5[1m]')).toBe(EXTENDED_CONTEXT_WINDOW)
  expect(contextWindowFor('opus[1M]')).toBe(EXTENDED_CONTEXT_WINDOW)
  expect(EXTENDED_CONTEXT_WINDOW).toBe(1_000_000)
})

it('knows a 1M variant by its suffix, whatever the case, and only at the end', () => {
  expect(isExtendedId('opus[1m]')).toBe(true)
  expect(isExtendedId('claude-opus-5-5[1M]')).toBe(true)
  expect(isExtendedId('opus')).toBe(false)
  expect(isExtendedId('[1m]opus')).toBe(false)
  expect(withoutExtended('opus[1m]')).toBe('opus')
  expect(withoutExtended('claude-sonnet-5')).toBe('claude-sonnet-5')
  expect(mentionsExtended('Opus (1M context)')).toBe(true)
  expect(mentionsExtended('Opus 5.5 with 1M context')).toBe(true)
  expect(mentionsExtended('Opus 5.5')).toBe(false)
  expect(mentionsExtended('A 21M parameter toy')).toBe(false)
})

describe('matchReportedWindow', () => {
  const opus = { 'claude-opus-5-5': 1_000_000, 'claude-haiku-4-5-20251001': 200_000 }

  it('takes the entry keyed by the first name that has one', () => {
    expect(matchReportedWindow(opus, ['claude-opus-5-5', 'opus'])).toEqual({
      model: 'claude-opus-5-5',
      window: 1_000_000,
    })
    // The init's model has none, the task's full id does.
    expect(matchReportedWindow(opus, ['claude-opus-5-5[1m]', 'opus', 'claude-opus-5-5'])).toEqual({
      model: 'claude-opus-5-5',
      window: 1_000_000,
    })
    expect(matchReportedWindow(opus, ['claude-haiku-4-5-20251001'])?.window).toBe(200_000)
  })

  it('else the entry that is one of the names spelled another way: the case, or a date', () => {
    expect(matchReportedWindow(opus, ['claude-haiku-4-5'])).toEqual({
      model: 'claude-haiku-4-5-20251001',
      window: 200_000,
    })
    expect(matchReportedWindow({ 'claude-haiku-4-5': 200_000, other: 1 }, ['claude-haiku-4-5-20251001'])?.window).toBe(
      200_000,
    )
    expect(matchReportedWindow({ 'Claude-Opus-5-5[1M]': 1_000_000, other: 1 }, ['claude-opus-5-5[1m]'])?.window).toBe(
      1_000_000,
    )
    expect(
      matchReportedWindow({ 'claude-opus-5-5-20260901[1m]': 1_000_000, other: 1 }, ['claude-opus-5-5[1m]']),
    ).toEqual({ model: 'claude-opus-5-5-20260901[1m]', window: 1_000_000 })
  })

  it('else the only entry, whatever its key, and none among several', () => {
    // #416: the task's model is an alias the list doesn't resolve, and the result is keyed by the full id.
    expect(matchReportedWindow({ 'claude-opus-5-5': 1_000_000 }, ['opus'])).toEqual({
      model: 'claude-opus-5-5',
      window: 1_000_000,
    })
    expect(matchReportedWindow({ 'claude-opus-5-5': 1_000_000 }, [])?.window).toBe(1_000_000)
    expect(matchReportedWindow(opus, ['opus'])).toBeUndefined()
    // The base model's entry isn't the 1M variant's.
    expect(matchReportedWindow(opus, ['claude-opus-5-5[1m]'])).toBeUndefined()
    expect(matchReportedWindow({}, ['opus'])).toBeUndefined()
  })
})

describe('fitContextWindow', () => {
  it('keeps a window that holds what was seen in it', () => {
    expect(fitContextWindow(200_000, 0)).toBe(200_000)
    expect(fitContextWindow(200_000, 200_000)).toBe(200_000)
    expect(fitContextWindow(180_000, 76_000)).toBe(180_000)
  })

  // #416: 905k used of "200k".
  it('takes the smallest window the SDK gives that holds more than the window did, else what was seen', () => {
    expect(fitContextWindow(200_000, 905_000)).toBe(1_000_000)
    expect(fitContextWindow(200_000, 200_001)).toBe(1_000_000)
    expect(fitContextWindow(50_000, 60_000)).toBe(200_000)
    expect(fitContextWindow(1_000_000, 1_200_000)).toBe(1_200_000)
  })
})

it('gives every other model the standard 200k window', () => {
  expect(contextWindowFor('claude-sonnet-5')).toBe(STANDARD_CONTEXT_WINDOW)
  expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000)
})

it('puts the auto-compact threshold where the SDK does: 167k of 200k, 967k of 1M', () => {
  expect(autoCompactThreshold(200_000)).toBe(167_000)
  expect(autoCompactThreshold(1_000_000)).toBe(967_000)
})

it('never puts the threshold below nothing, however small the window', () => {
  expect(autoCompactThreshold(30_000)).toBe(0)
})
