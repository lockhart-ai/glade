import { describe, expect, it } from 'vitest'
import { UsageWindow } from '../../shared/account'
import { usageLimitName, usageNoteText } from './usageModel'

const NOW = new Date(2026, 8, 26, 9, 0).getTime()
const RESETS = new Date(2026, 8, 26, 11, 42).getTime()

describe('usageNoteText', () => {
  it('says how much of the window is used and when it resets, as the design words it', () => {
    expect(usageNoteText({ utilization: 0.85, window: UsageWindow.Session, resetsAt: RESETS }, NOW)).toEqual({
      lead: 'You’ve used 85% of your session limit',
      resets: ' · resets 11:42',
    })
  })

  it('rounds down, as Claude Code does, so it never says more than is used', () => {
    expect(usageNoteText({ utilization: 0.999, window: UsageWindow.Weekly, resetsAt: null }, NOW).lead).toBe(
      'You’ve used 99% of your weekly limit',
    )
  })

  it("says the limit is close when the SDK doesn't say how much is used, and leaves out a reset it doesn't give", () => {
    expect(usageNoteText({ utilization: null, window: UsageWindow.WeeklyOpus, resetsAt: null }, NOW)).toEqual({
      lead: 'You’re close to your weekly Opus limit',
      resets: null,
    })
  })

  it('gives the day of a reset on another day', () => {
    const later = new Date(2026, 8, 30, 14, 0).getTime()
    expect(usageNoteText({ utilization: 0.7, window: UsageWindow.Weekly, resetsAt: later }, NOW).resets).toBe(
      ' · resets Sep 30 14:00',
    )
  })
})

describe('usageLimitName', () => {
  it('names each window as Claude Code does', () => {
    expect(Object.values(UsageWindow).map(usageLimitName)).toEqual([
      'session limit',
      'weekly limit',
      'weekly Opus limit',
      'weekly Sonnet limit',
      'usage limit',
    ])
  })
})
