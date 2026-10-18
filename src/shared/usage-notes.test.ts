// What Glade tells an agent about usage: the line a turn's prompt ends with, and the thresholds a working task is
// told of mid-turn.
import { describe, expect, it } from 'vitest'
import { UsageLevel, UsageLimitKind, type UsageLimit, type UsageReading } from './account'
import { usageLine, usageNote, usageNoteCurrent, usageResetsUtc, spendMoney } from './usage-notes'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

const reading = (
  kind: UsageLimitKind,
  utilization: number | null,
  resetsIn: number | null = 2 * HOUR,
): UsageReading => ({
  limit: { kind } as UsageLimit,
  utilization,
  resetsAt: resetsIn === null ? null : NOW + resetsIn,
  level: utilization === null ? UsageLevel.Limited : UsageLevel.Within,
  readAt: NOW,
})

const readings = (...items: readonly UsageReading[]): readonly UsageReading[] => items

describe('usageNoteCurrent', () => {
  it('reads the session and the week off the standing readings, and the spend', () => {
    expect(
      usageNoteCurrent(
        readings(
          reading(UsageLimitKind.Session, 0.41),
          reading(UsageLimitKind.Weekly, 0.59),
          reading(UsageLimitKind.WeeklyModel, 0.2),
        ),
        12.34,
        NOW,
      ),
    ).toEqual({
      session: 0.41,
      week: 0.59,
      sessionResetsAt: NOW + 2 * HOUR,
      weekResetsAt: NOW + 2 * HOUR,
      spend: 12.34,
    })
  })

  it('leaves out a window that has reset, and keeps a null utilization as null', () => {
    expect(
      usageNoteCurrent(
        readings(reading(UsageLimitKind.Session, 0.41, -HOUR), reading(UsageLimitKind.Weekly, null)),
        null,
        NOW,
      ),
    ).toEqual({
      session: null,
      week: null,
      sessionResetsAt: null,
      weekResetsAt: NOW + 2 * HOUR,
      spend: null,
    })
  })
})

describe('usageResetsUtc', () => {
  it('names the clock time in UTC on the same day, and the day with it on another', () => {
    expect(usageResetsUtc(Date.parse('2026-10-18T08:30:00Z'), Date.parse('2026-10-18T03:00:00Z'))).toBe('08:30 UTC')
    expect(usageResetsUtc(Date.parse('2026-10-23T06:00:00Z'), Date.parse('2026-10-18T12:00:00Z'))).toBe(
      'Oct 23 06:00 UTC',
    )
  })
})

describe('spendMoney', () => {
  it('names dollars to the cent, and a spend under a cent with its decimals', () => {
    expect(spendMoney(12.345)).toBe('$12.35')
    expect(spendMoney(20)).toBe('$20.00')
    expect(spendMoney(0.000081)).toBe('$0.000081')
  })
})

describe('usageLine', () => {
  const current = usageNoteCurrent(
    readings(reading(UsageLimitKind.Session, 0.41), reading(UsageLimitKind.Weekly, 0.59, 4 * DAY + 18 * HOUR)),
    12.34,
    NOW,
  )

  it('says both windows with their resets', () => {
    expect(usageLine(current, false, NOW)).toBe(
      'Usage: session 41% (resets 14:00 UTC), week 59% (resets Oct 23 06:00 UTC).',
    )
  })

  it('adds the OpenRouter spend only for a task that runs on OpenRouter', () => {
    expect(usageLine(current, true, NOW)).toBe(
      'Usage: session 41% (resets 14:00 UTC), week 59% (resets Oct 23 06:00 UTC), OpenRouter spend $12.34.',
    )
  })

  it('says a window without a reset time plainly', () => {
    const noResets = { ...current, weekResetsAt: null }
    expect(usageLine(noResets, false, NOW)).toBe('Usage: session 41% (resets 14:00 UTC), week 59%.')
  })

  it('is null when nothing says how much is used', () => {
    expect(usageLine(usageNoteCurrent([], null, NOW), true, NOW)).toBeNull()
  })

  it('says the spend alone for a task on OpenRouter with no plan readings', () => {
    expect(
      usageLine({ session: null, week: null, sessionResetsAt: null, weekResetsAt: null, spend: 12.34 }, true, NOW),
    ).toBe('Usage: OpenRouter spend $12.34.')
  })
})

describe('usageNote', () => {
  const STEP = { usageNoteStepPercent: 10, usageNoteStepDollars: 10 }
  const current = usageNoteCurrent(
    readings(reading(UsageLimitKind.Session, 0.41), reading(UsageLimitKind.Weekly, 0.59, 4 * DAY + 18 * HOUR)),
    12.34,
    NOW,
  )

  it('tells a task never told anything nothing, and starts it from where things stand', () => {
    const { note, announced } = usageNote(current, undefined, STEP, NOW)
    expect(note).toBeNull()
    expect(announced).toEqual({ session: 0.41, week: 0.59, spend: 12.34 })
  })

  it('tells each threshold crossed once, with its reset time', () => {
    const after = { ...current, session: 0.512, week: 0.7, spend: 12.34 }
    const { note, announced } = usageNote(after, { session: 0.41, week: 0.59, spend: 12.34 }, STEP, NOW)
    expect(note).toBe(
      'Usage: the session is now at 51% (resets 14:00 UTC), the week is now at 70% (resets Oct 23 06:00 UTC).',
    )
    expect(announced).toEqual({ session: 0.512, week: 0.7, spend: 12.34 })

    // The same thresholds again say nothing.
    expect(usageNote(after, announced, STEP, NOW).note).toBeNull()
  })

  it('tells the spend alone, naming the step it crossed', () => {
    const { note } = usageNote({ ...current, spend: 20.05 }, { session: 0.41, week: 0.59, spend: 12.34 }, STEP, NOW)
    expect(note).toBe('Usage: OpenRouter spend is now $20.05.')
  })

  it('starts a window over quietly after it resets, and tells the next crossing after that', () => {
    const first = usageNote(current, undefined, STEP, NOW)
    const afterReset = { ...current, session: 0.03, week: 0.02 }
    const reset = usageNote(afterReset, first.announced, STEP, NOW)
    expect(reset.note).toBeNull()
    expect(reset.announced).toEqual({ session: 0.03, week: 0.02, spend: 12.34 })

    const climbed = usageNote({ ...afterReset, session: 0.12 }, reset.announced, STEP, NOW)
    expect(climbed.note).toBe('Usage: the session is now at 12% (resets 14:00 UTC).')
  })

  it('respects the settings: a bigger step crosses later, and off says nothing', () => {
    const bigger = usageNote(
      { ...current, session: 0.19 },
      { session: 0.1, week: 0.59, spend: 12.34 },
      { ...STEP, usageNoteStepPercent: 20 },
      NOW,
    )
    expect(bigger.note).toBeNull()
    expect(bigger.announced.session).toBe(0.19)

    const off = usageNote(
      { ...current, session: 0.99, week: 0.99, spend: 999 },
      { session: 0.1, week: 0.59, spend: 12.34 },
      { usageNoteStepPercent: null, usageNoteStepDollars: null },
      NOW,
    )
    expect(off.note).toBeNull()
  })

  it('keeps what it was told of a window the readings no longer name', () => {
    const gone = { ...current, session: null, week: null, spend: null }
    const { note, announced } = usageNote(gone, { session: 0.41, week: 0.59, spend: 12.34 }, STEP, NOW)
    expect(note).toBeNull()
    expect(announced).toEqual({ session: 0.41, week: 0.59, spend: 12.34 })
  })

  it('names a crossed threshold without a reset time plainly', () => {
    const noResets = { ...current, sessionResetsAt: null }
    const { note } = usageNote(noResets, { session: 0.31, week: 0.59, spend: null }, STEP, NOW)
    expect(note).toBe('Usage: the session is now at 41%.')
  })
})
