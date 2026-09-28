// How the control API reads a date (`./dates`): a date alone is that day at local noon wherever Glade runs, so it never
// slips a day; a date and time with its offset is that instant, whatever the time zone. Each test runs in several time
// zones, set with TZ, which Node reads again whenever it changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { instantOf, ISO_INSTANT_MESSAGE, isoInstant, parseInstant } from './dates'
import { ControlError, ControlErrorCode } from './errors'

/** Zones from UTC−11 to UTC+14, with and without summer time, and two that change the clock at midnight. */
const ZONES = [
  'UTC',
  'America/Toronto',
  'America/Los_Angeles',
  'Pacific/Pago_Pago', // UTC−11: UTC midnight here is 13:00 the day before
  'Pacific/Kiritimati', // UTC+14: local noon here is 22:00 UTC the day before
  'Asia/Kolkata', // a half-hour offset
  'Australia/Lord_Howe', // a half-hour summer time
  'America/Santiago', // summer time starts at midnight: a day with no 00:00
  'Asia/Beirut', // likewise
]

const LATER = Date.parse('2030-01-01T00:00:00Z')

let zone: string | undefined

beforeEach(() => {
  zone = process.env.TZ
})

afterEach(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

/** The local calendar day and time of an instant, as the zone set now reads it. */
function local(at: number): { day: string; hours: number; minutes: number } {
  const date = new Date(at)
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0'))
  return { day: day.join('-'), hours: date.getHours(), minutes: date.getMinutes() }
}

describe('a date alone', () => {
  it.each(ZONES)('is that day at noon local time, in %s', (tz) => {
    process.env.TZ = tz
    // Among them the days the clocks change: in North America, Chile (at midnight) and Lebanon (at midnight).
    const days = ['2026-09-25', '2026-03-08', '2026-11-01', '2026-09-06', '2026-03-29', '2026-12-31', '2028-02-29']
    for (const day of days) {
      expect(local(parseInstant(day, LATER)), day).toEqual({ day, hours: 12, minutes: 0 })
    }
  })

  it.each(ZONES)('is never the day before or after, at either end of the year, in %s', (tz) => {
    process.env.TZ = tz
    const at = parseInstant('2026-01-01', LATER)
    expect(new Date(at).getDate()).toBe(1)
    expect(new Date(at).getFullYear()).toBe(2026)
  })

  it('stands for a different instant in each zone: the one where it is that day', () => {
    process.env.TZ = 'Pacific/Kiritimati'
    const east = parseInstant('2026-09-25', LATER)
    process.env.TZ = 'Pacific/Pago_Pago'
    const west = parseInstant('2026-09-25', LATER)

    expect(east).toBe(Date.parse('2026-09-24T22:00:00Z'))
    expect(west).toBe(Date.parse('2026-09-25T23:00:00Z'))
  })

  it('is read in the summer time of its own day, not today’s', () => {
    process.env.TZ = 'America/Toronto'
    expect(parseInstant('2026-01-15', LATER)).toBe(Date.parse('2026-01-15T17:00:00Z'))
    expect(parseInstant('2026-07-15', LATER)).toBe(Date.parse('2026-07-15T16:00:00Z'))
  })

  it('reads the years before 100 as themselves, not as the 1900s', () => {
    process.env.TZ = 'UTC'
    const at = new Date(parseInstant('0050-06-01', LATER))
    expect([at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()]).toEqual([50, 5, 1, 12])
  })

  it('is no date for a day the month does not have', () => {
    process.env.TZ = 'UTC'
    expect(parseInstant('2026-02-30', LATER)).toBeNaN()
    expect(parseInstant('2026-13-01', LATER)).toBeNaN()
  })

  it.each(ZONES)('is now for today before noon, so today is never in the future, in %s', (tz) => {
    process.env.TZ = tz
    const morning = new Date(2026, 8, 25, 9, 30).getTime()
    const evening = new Date(2026, 8, 25, 18).getTime()

    expect(parseInstant('2026-09-25', morning)).toBe(morning)
    expect(instantOf('2026-09-25', 'startedAt', morning)).toBe(morning)
    expect(parseInstant('2026-09-25', evening)).toBe(new Date(2026, 8, 25, 12).getTime())
  })

  it.each(ZONES)('is in the future from tomorrow, in %s', (tz) => {
    process.env.TZ = tz
    const lateTonight = new Date(2026, 8, 25, 23, 59).getTime()

    expect(() => instantOf('2026-09-26', 'startedAt', lateTonight)).toThrow('startedAt: 2026-09-26 is in the future')
  })
})

describe('a date and time with its offset', () => {
  it.each(ZONES)('is that instant, whatever the zone, in %s', (tz) => {
    process.env.TZ = tz
    expect(parseInstant('2026-09-25T09:00:00+01:00', LATER)).toBe(Date.parse('2026-09-25T08:00:00Z'))
    expect(parseInstant('2026-09-25T00:00:00Z', LATER)).toBe(Date.UTC(2026, 8, 25))
    expect(parseInstant('2026-09-25T23:30:00.250-05:30', LATER)).toBe(Date.parse('2026-09-26T05:00:00.250Z'))
  })

  it('is refused when it is later than now, to the millisecond', () => {
    const now = Date.parse('2026-09-25T12:00:00Z')

    expect(instantOf('2026-09-25T12:00:00Z', 'updatedAt', now)).toBe(now)
    expect(() => instantOf('2026-09-25T12:00:00.001Z', 'updatedAt', now)).toThrow(
      'updatedAt: 2026-09-25T12:00:00.001Z is in the future',
    )
  })
})

describe('instantOf', () => {
  it('refuses what is no date as invalid input, naming the field', () => {
    let thrown: unknown
    try {
      instantOf('last March', 'patch.updatedAt', LATER)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ControlError)
    expect(thrown).toMatchObject({
      code: ControlErrorCode.InvalidInput,
      message: `patch.updatedAt: ${ISO_INSTANT_MESSAGE}`,
    })
    expect(() => instantOf('2026-02-30', 'startedAt', LATER)).toThrow(`startedAt: ${ISO_INSTANT_MESSAGE}`)
  })
})

describe('isoInstant', () => {
  const schema = z.strictObject({ at: isoInstant('When.') })

  it('takes a date, and a date and time with an offset or Z', () => {
    for (const at of [
      '2026-09-25',
      '2026-09-25T09:00:00Z',
      '2026-09-25T09:00:00+01:00',
      '2026-09-25T09:00:00.5-08:00',
    ]) {
      expect(schema.safeParse({ at }).success, at).toBe(true)
    }
  })

  it('refuses a date and time without an offset, a day that is not one, and anything else, saying what it takes', () => {
    for (const at of ['2026-09-25T09:00:00', '2026-02-30', '25/09/2026', 'yesterday', 1_790_000_000_000]) {
      const parsed = schema.safeParse({ at })
      expect(parsed.success, String(at)).toBe(false)
      expect(parsed.error?.issues.map(({ message }) => message)).toEqual([ISO_INSTANT_MESSAGE])
    }
  })

  it('lists as JSON Schema a date-time or a date, with its description', () => {
    expect(z.toJSONSchema(isoInstant('When.'))).toMatchObject({
      anyOf: [{ format: 'date-time' }, { format: 'date' }],
      description: 'When.',
    })
  })
})
