import { describe, expect, it } from 'vitest'
import { contextReading, formatTokens, NEAR_THRESHOLD_FRACTION } from './format'

describe('formatTokens', () => {
  it.each([
    [0, '0k'],
    [499, '0k'],
    [500, '1k'],
    [22_846, '23k'],
    [76_000, '76k'],
    [200_000, '200k'],
    [999_499, '999k'],
    [999_500, '1M'],
    [1_000_000, '1M'],
    [1_049_999, '1M'],
    [1_200_000, '1.2M'],
    [1_250_000, '1.3M'],
    [2_000_000, '2M'],
  ])('shows %d tokens as %s', (tokens, shown) => {
    expect(formatTokens(tokens)).toBe(shown)
  })
})

describe('contextReading', () => {
  it('reads the design sample: 38% · 76k / 200k', () => {
    expect(contextReading(76_000, 200_000)).toEqual({
      percent: 38,
      fraction: 0.38,
      used: '76k',
      window: '200k',
      thresholdPercent: 84,
      thresholdFraction: 0.835,
      nearThreshold: false,
    })
  })

  it('reads a new task as empty', () => {
    expect(contextReading(0, 200_000)).toMatchObject({ percent: 0, fraction: 0, used: '0k', window: '200k' })
  })

  it('rounds the percentage to the nearest whole one', () => {
    expect(contextReading(22_846, 1_000_000).percent).toBe(2)
    expect(contextReading(122_900, 200_000).percent).toBe(61)
    expect(contextReading(1_000, 200_000).percent).toBe(1)
    expect(contextReading(999, 200_000).percent).toBe(0)
  })

  it('keeps the ring within the window, however the numbers come', () => {
    expect(contextReading(250_000, 200_000)).toMatchObject({ percent: 100, fraction: 1 })
    expect(contextReading(-5, 200_000)).toMatchObject({ percent: 0, fraction: 0 })
    expect(contextReading(5, 0)).toMatchObject({ percent: 0, fraction: 0, window: '0k' })
  })

  it('puts the auto-compact threshold where the SDK does: 84% of 200k, 97% of 1M', () => {
    expect(contextReading(0, 200_000)).toMatchObject({ thresholdPercent: 84, thresholdFraction: 0.835 })
    expect(contextReading(0, 1_000_000)).toMatchObject({ thresholdPercent: 97, thresholdFraction: 0.967 })
    expect(contextReading(0, 0)).toMatchObject({ thresholdPercent: 0, thresholdFraction: 0, nearThreshold: false })
  })

  it('is near the threshold within a tenth of the window below it, and past it', () => {
    expect(NEAR_THRESHOLD_FRACTION).toBe(0.1)
    // 167k is the threshold of 200k, so the ring turns purple from 147k.
    expect(contextReading(146_999, 200_000).nearThreshold).toBe(false)
    expect(contextReading(147_000, 200_000).nearThreshold).toBe(true)
    expect(contextReading(194_000, 200_000).nearThreshold).toBe(true)
    expect(contextReading(866_999, 1_000_000).nearThreshold).toBe(false)
    expect(contextReading(867_000, 1_000_000).nearThreshold).toBe(true)
  })
})
