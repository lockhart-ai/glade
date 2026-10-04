import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageLevel, UsageLimitKind, UsageWindow, type UsageReading, type UsageSnapshot } from '../../shared/account'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { AgentEventKind, RateLimitStatus, type RateLimitEvent } from '../agent/events'
import { MAX_TIMER_MS } from '../agent/pauses'
import { getAccount, listUsageReadings, replaceUsageReadings, saveAccount } from '../db/repositories/account'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { LogLevel } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import {
  createAccountTracker,
  eventReading,
  limitOfWindow,
  parseAccountInfo,
  parseUsage,
  UsageAnswerKind,
  type AccountTracker,
} from './account'

const NOW = 1_790_000_000_000
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

let database: TestDatabase
let events: GladeEvent[]
let log: MemoryLog
let tracker: AccountTracker | null

function track(): AccountTracker {
  tracker = createAccountTracker({ db: database.db, emit: (event) => events.push(event), log: log.logger })
  return tracker
}

function limit(fields: Partial<RateLimitEvent> = {}): RateLimitEvent {
  return {
    kind: AgentEventKind.RateLimit,
    status: RateLimitStatus.AllowedWarning,
    resetsAt: NOW + HOUR,
    utilization: 0.85,
    window: UsageWindow.Session,
    ...fields,
  }
}

/** An ISO time `ms` from now, as the usage call gives its resets. */
const iso = (ms: number): string => new Date(NOW + ms).toISOString()

/** The usage call's answer, as probed on SDK 0.3.281 for a Max login: invented values. */
function answer(rateLimits: Record<string, unknown> | null = {}, available = true): unknown {
  return {
    session: { total_cost_usd: 0.4, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: available,
    rate_limits:
      rateLimits === null
        ? null
        : {
            five_hour: { utilization: 38, resets_at: iso(2 * HOUR) },
            seven_day: { utilization: 22, resets_at: iso(4 * DAY) },
            seven_day_oauth_apps: null,
            seven_day_opus: { utilization: 9, resets_at: iso(4 * DAY) },
            seven_day_sonnet: null,
            extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
            ...rateLimits,
          },
    behaviors: null,
  }
}

/**
 * The call's `extra_usage` with extra usage on and nothing spent, in the shape probed on a real login on Oct 4
 * (`docs/sdk-notes.md`, "Usage limits"): the amounts are in cents, and the values made up.
 */
const EXTRA_ON = {
  is_enabled: true,
  monthly_limit: 5000,
  used_credits: 0,
  utilization: null,
  currency: 'USD',
  disabled_reason: null,
  decimal_places: 2,
  user_disabled: false,
  spend_limit_reached: false,
  credits_ever_enabled: true,
  daily: null,
  weekly: null,
}

const SESSION: UsageReading = {
  limit: { kind: UsageLimitKind.Session },
  utilization: 0.38,
  resetsAt: NOW + 2 * HOUR,
  level: UsageLevel.Within,
  readAt: NOW,
}
const WEEK: UsageReading = {
  limit: { kind: UsageLimitKind.Weekly },
  utilization: 0.22,
  resetsAt: NOW + 4 * DAY,
  level: UsageLevel.Within,
  readAt: NOW,
}
const OPUS: UsageReading = { ...WEEK, limit: { kind: UsageLimitKind.WeeklyModel, model: 'Opus' }, utilization: 0.09 }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  database = openTestDatabase()
  events = []
  log = createMemoryLog()
  tracker = null
})

afterEach(() => {
  tracker?.close()
  database.close()
  vi.useRealTimers()
})

describe('parseAccountInfo', () => {
  it('reads what Claude Code reports, field for field, a field it leaves out as null', () => {
    expect(
      parseAccountInfo(
        {
          email: 'sam@acme.dev',
          organization: 'Acme Robotics',
          subscriptionType: 'Claude Max',
          apiProvider: 'firstParty',
        },
        5,
      ),
    ).toEqual({
      email: 'sam@acme.dev',
      organization: 'Acme Robotics',
      subscriptionType: 'Claude Max',
      tokenSource: null,
      apiKeySource: null,
      apiProvider: 'firstParty',
      readAt: 5,
    })
  })

  it('takes a malformed or empty field as left out, and anything but an object as nothing to read', () => {
    expect(parseAccountInfo({ email: 42, tokenSource: '', apiKeySource: 'apiKeyHelper', extra: true }, 5)).toEqual({
      email: null,
      organization: null,
      subscriptionType: null,
      tokenSource: null,
      apiKeySource: 'apiKeyHelper',
      apiProvider: null,
      readAt: 5,
    })
    expect(parseAccountInfo({}, 5)).toMatchObject({ email: null, apiProvider: null })
    for (const raw of [null, undefined, 'sam@acme.dev', []]) expect(parseAccountInfo(raw, 5)).toBeNull()
  })
})

describe('parseUsage', () => {
  it('reads every window with how much is used, as a fraction, and when it resets', () => {
    expect(parseUsage(answer(), NOW)).toEqual({
      kind: UsageAnswerKind.Readings,
      readings: [SESSION, WEEK, OPUS],
      extraUsageAvailable: false,
    })
  })

  it('reads the per-model windows the server names, and extra usage while it’s on', () => {
    const parsed = parseUsage(
      answer({
        five_hour: { utilization: 100, resets_at: iso(HOUR) },
        seven_day_sonnet: { utilization: 71, resets_at: iso(4 * DAY) },
        model_scoped: [
          { display_name: 'Fable', utilization: 40, resets_at: iso(4 * DAY) },
          // A model already read from its own window keeps that reading.
          { display_name: 'Opus', utilization: 50, resets_at: iso(4 * DAY) },
          { display_name: '', utilization: 3 },
          'nonsense',
        ],
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1240, utilization: 24.8 },
      }),
      NOW,
    )
    expect(parsed).toEqual({
      kind: UsageAnswerKind.Readings,
      readings: [
        { ...SESSION, utilization: 1, resetsAt: NOW + HOUR, level: UsageLevel.Limited },
        WEEK,
        { ...WEEK, limit: { kind: UsageLimitKind.WeeklyModel, model: 'Fable' }, utilization: 0.4 },
        OPUS,
        {
          ...WEEK,
          limit: { kind: UsageLimitKind.WeeklyModel, model: 'Sonnet' },
          utilization: 0.71,
          level: UsageLevel.Warning,
        },
        { ...SESSION, limit: { kind: UsageLimitKind.ExtraUsage }, utilization: 0.248, resetsAt: null },
      ],
      // Nothing here says whether it's disabled or its spend limit reached: not known, so not available.
      extraUsageAvailable: false,
    })
  })

  it('reads extra usage that’s on with nothing spent yet, when the call gives no percentage (#519)', () => {
    // What the call answered on a login with extra usage on, Oct 4 (`docs/sdk-notes.md`): the values are made up.
    const parsed = parseUsage(
      answer({ five_hour: { utilization: 100, resets_at: iso(HOUR) }, extra_usage: EXTRA_ON }),
      NOW,
    )

    expect(parsed).toMatchObject({ kind: UsageAnswerKind.Readings, extraUsageAvailable: true })
    expect(parsed.kind === UsageAnswerKind.Readings && parsed.readings.at(-1)).toEqual({
      limit: { kind: UsageLimitKind.ExtraUsage },
      utilization: 0,
      resetsAt: null,
      level: UsageLevel.Within,
      readAt: NOW,
    })
  })

  it.each<[string, Record<string, unknown>, number | null, UsageLevel]>([
    ['the call’s own percentage', { utilization: 24.8, used_credits: 9999 }, 0.248, UsageLevel.Within],
    ['what’s spent of the cap, with no percentage', { used_credits: 1250 }, 0.25, UsageLevel.Within],
    ['close to the cap', { used_credits: 4000 }, 0.8, UsageLevel.Warning],
    ['the cap spent', { used_credits: 5000, spend_limit_reached: true }, 1, UsageLevel.Limited],
    ['past the cap', { used_credits: 6000 }, 1.2, UsageLevel.Limited],
    ['no cap: no amount, but still a row', { monthly_limit: null, used_credits: 310 }, null, UsageLevel.Within],
    ['a cap of nothing: no amount', { monthly_limit: 0, used_credits: 0 }, null, UsageLevel.Within],
    ['nothing said of what’s spent', { used_credits: null }, null, UsageLevel.Within],
    ['a malformed cap', { monthly_limit: 'lots', used_credits: 10 }, null, UsageLevel.Within],
    ['a malformed amount spent', { used_credits: -5 }, null, UsageLevel.Within],
  ])('reads how much of extra usage is used from %s', (_, fields, utilization, level) => {
    const parsed = parseUsage(answer({ extra_usage: { ...EXTRA_ON, ...fields } }), NOW)

    expect(parsed.kind === UsageAnswerKind.Readings && parsed.readings.at(-1)).toEqual({
      limit: { kind: UsageLimitKind.ExtraUsage },
      utilization,
      resetsAt: null,
      level,
      readAt: NOW,
    })
  })

  it('reads no extra usage while it’s off, whatever else it says', () => {
    const parsed = parseUsage(answer({ extra_usage: { ...EXTRA_ON, is_enabled: false } }), NOW)

    expect(parsed).toEqual({
      kind: UsageAnswerKind.Readings,
      readings: [SESSION, WEEK, OPUS],
      extraUsageAvailable: false,
    })
  })

  it.each<[string, Record<string, unknown> | null, boolean]>([
    ['on, nothing disabling it, under its cap', {}, true],
    ['on with part of its cap spent', { used_credits: 4999 }, true],
    ['on with no cap, the call says so', { monthly_limit: null, used_credits: 310 }, true],
    ['off', { is_enabled: false }, false],
    ['on, but not saying it is', { is_enabled: 'yes' }, false],
    ['its cap spent', { used_credits: 5000 }, false],
    ['its cap spent, by its own percentage', { utilization: 100 }, false],
    ['its spend limit reached', { spend_limit_reached: true }, false],
    ['disabled for a reason', { disabled_reason: 'out_of_credits' }, false],
    ['not saying whether its spend limit is reached', { spend_limit_reached: undefined }, false],
    ['a malformed spend limit', { spend_limit_reached: 'no' }, false],
    ['not saying whether it’s disabled', { disabled_reason: undefined }, false],
    ['a malformed reason', { disabled_reason: 0 }, false],
    ['a cap of nothing', { monthly_limit: 0 }, false],
    ['not saying its cap', { monthly_limit: undefined }, false],
    ['a malformed cap', { monthly_limit: 'lots' }, false],
    ['a cap, but not what’s spent of it', { used_credits: undefined }, false],
    ['no word of extra usage at all', null, false],
  ])('takes extra usage as available only when the call says all of it outright: %s', (_, fields, available) => {
    const parsed = parseUsage(answer({ extra_usage: fields === null ? undefined : { ...EXTRA_ON, ...fields } }), NOW)

    expect(parsed).toMatchObject({ kind: UsageAnswerKind.Readings, extraUsageAvailable: available })
  })

  it('leaves out a malformed window, one with no amount, and one already reset; a bad reset time is none', () => {
    const parsed = parseUsage(
      answer({
        five_hour: { utilization: 'lots', resets_at: iso(HOUR) },
        seven_day: { utilization: null, resets_at: iso(4 * DAY) },
        seven_day_opus: { utilization: 9, resets_at: iso(-MINUTE) },
        seven_day_sonnet: { utilization: 12, resets_at: 'next Tuesday' },
        model_scoped: 'none',
        extra_usage: 'on',
      }),
      NOW,
    )
    expect(parsed).toEqual({
      kind: UsageAnswerKind.Readings,
      readings: [
        {
          ...WEEK,
          limit: { kind: UsageLimitKind.WeeklyModel, model: 'Sonnet' },
          utilization: 0.12,
          resetsAt: null,
        },
      ],
      extraUsageAvailable: false,
    })
  })

  it('says when plan limits don’t apply, as for an API key', () => {
    expect(parseUsage(answer(null, false), NOW)).toEqual({ kind: UsageAnswerKind.NoPlanLimits })
    expect(parseUsage(answer(null), NOW)).toEqual({ kind: UsageAnswerKind.NoPlanLimits })
  })

  it('makes nothing of an answer of another shape, or one with not one window in it', () => {
    for (const raw of [
      null,
      'usage',
      [],
      {},
      { rate_limits_available: 'yes', rate_limits: {} },
      { rate_limits_available: true, rate_limits: 'all fine' },
      answer({ five_hour: null, seven_day: null, seven_day_opus: null }),
    ]) {
      expect(parseUsage(raw, NOW)).toEqual({ kind: UsageAnswerKind.NotUnderstood })
    }
  })
})

describe('eventReading', () => {
  it('knows each window the SDK names, and none it doesn’t', () => {
    expect(limitOfWindow(UsageWindow.Session)).toEqual({ kind: UsageLimitKind.Session })
    expect(limitOfWindow(UsageWindow.Weekly)).toEqual({ kind: UsageLimitKind.Weekly })
    expect(limitOfWindow(UsageWindow.WeeklyOpus)).toEqual({ kind: UsageLimitKind.WeeklyModel, model: 'Opus' })
    expect(limitOfWindow(UsageWindow.WeeklySonnet)).toEqual({ kind: UsageLimitKind.WeeklyModel, model: 'Sonnet' })
    expect(limitOfWindow(UsageWindow.Overage)).toEqual({ kind: UsageLimitKind.ExtraUsage })
    expect(limitOfWindow(UsageWindow.Other)).toBeNull()
    expect(eventReading(limit({ window: UsageWindow.Other }), undefined, NOW)).toBeNull()
  })

  it('is close to the limit from 70%, as Claude Code warns, however early the API says allowed_warning', () => {
    expect(eventReading(limit(), undefined, NOW)).toEqual({
      limit: { kind: UsageLimitKind.Session },
      utilization: 0.85,
      resetsAt: NOW + HOUR,
      level: UsageLevel.Warning,
      readAt: NOW,
    })
    expect(eventReading(limit({ utilization: 0.7 }), undefined, NOW)?.level).toBe(UsageLevel.Warning)
    // As probed: a warning at 28% of a week. Claude Code shows nothing, and the meter stays blue.
    expect(eventReading(limit({ utilization: 0.28 }), undefined, NOW)?.level).toBe(UsageLevel.Within)
    expect(eventReading(limit({ utilization: null }), undefined, NOW)?.level).toBe(UsageLevel.Warning)
  })

  it('is at the limit only once the SDK refuses requests', () => {
    const rejected = limit({ status: RateLimitStatus.Rejected, utilization: null })
    expect(eventReading(rejected, undefined, NOW)?.level).toBe(UsageLevel.Limited)
    expect(eventReading(limit({ status: RateLimitStatus.Allowed, utilization: 1 }), undefined, NOW)?.level).toBe(
      UsageLevel.Warning,
    )
    expect(eventReading(limit({ status: RateLimitStatus.Allowed, utilization: null }), undefined, NOW)?.level).toBe(
      UsageLevel.Within,
    )
  })

  it('keeps how much was used, and when it resets, when the event doesn’t say', () => {
    const allowed = limit({ status: RateLimitStatus.Allowed, utilization: null, resetsAt: null })
    expect(eventReading(allowed, { ...SESSION, utilization: 0.75, readAt: 1 }, NOW)).toEqual({
      ...SESSION,
      utilization: 0.75,
      level: UsageLevel.Warning,
    })
  })

  it('reads nothing of a window that has already reset', () => {
    expect(eventReading(limit({ resetsAt: NOW }), undefined, NOW)).toBeNull()
  })
})

describe('createAccountTracker', () => {
  it('has no account and no usage to begin with', () => {
    expect(track().status()).toEqual({ account: null, usage: [] })
  })

  it('saves each account read, broadcasts it, and logs it without the email or organization', () => {
    const account = track()
    account.accountRead({
      email: 'sam@acme.dev',
      organization: 'Acme Robotics',
      subscriptionType: 'Claude Max',
      apiProvider: 'firstParty',
    })

    const saved = getAccount(database.db)
    expect(saved).toMatchObject({ email: 'sam@acme.dev', subscriptionType: 'Claude Max', readAt: NOW })
    expect(events).toEqual([{ type: EventType.AccountChanged, status: { account: saved, usage: [] } }])
    expect(JSON.stringify(log.records)).not.toMatch(/sam@acme|Acme Robotics/)
    expect(log.withMessage('account read')[0]?.fields).toMatchObject({ kind: 'login', plan: 'Claude Max' })

    // Signed in again with an API key: it replaces the one before.
    vi.advanceTimersByTime(1000)
    account.accountRead({ tokenSource: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })
    expect(getAccount(database.db)).toEqual({
      email: null,
      organization: null,
      subscriptionType: null,
      tokenSource: 'claude.ai',
      apiKeySource: 'ANTHROPIC_API_KEY',
      apiProvider: 'firstParty',
      readAt: NOW + 1000,
    })
    expect(events).toHaveLength(2)
  })

  it('keeps the account it has when a read makes no sense', () => {
    const before = parseAccountInfo({ email: 'sam@acme.dev' }, 1)
    if (before !== null) saveAccount(database.db, before)
    const account = track()

    account.accountRead('not an account')

    expect(getAccount(database.db)?.email).toBe('sam@acme.dev')
    expect(events).toEqual([])
    expect(log.records).toContainEqual(expect.objectContaining({ level: LogLevel.Warn }))
  })

  it('reads every window from the usage call, in place of every reading before, and broadcasts them', () => {
    const account = track()
    account.rateLimit(limit({ window: UsageWindow.WeeklySonnet }))
    account.usageRead(answer())

    expect(account.status().usage).toEqual([SESSION, WEEK, OPUS])
    expect(listUsageReadings(database.db)).toEqual([SESSION, WEEK, OPUS])
    expect(events.at(-1)).toEqual({
      type: EventType.AccountChanged,
      status: { account: null, usage: [SESSION, WEEK, OPUS] },
    })
    expect(log.withMessage('usage read from the usage call')).toHaveLength(1)
  })

  it('hands each answer that gave readings on, once they’re saved and broadcast, and no other', () => {
    const heard: UsageSnapshot[] = []
    tracker = createAccountTracker({
      db: database.db,
      emit: (event) => events.push(event),
      onUsageRead: (usage) => {
        // By now the window has the readings too.
        expect(events.at(-1)).toMatchObject({ type: EventType.AccountChanged })
        expect(listUsageReadings(database.db)).toEqual(usage.readings)
        heard.push(usage)
      },
    })

    tracker.usageRead(answer({ extra_usage: EXTRA_ON }))
    tracker.usageRead({ rate_limits: 'unexpected' })
    tracker.usageRead(answer(null, false))
    tracker.rateLimit(limit())

    expect(heard).toEqual([
      {
        readings: [SESSION, WEEK, OPUS, expect.objectContaining({ limit: { kind: UsageLimitKind.ExtraUsage } })],
        extraUsageAvailable: true,
      },
    ])
  })

  it('falls back to the rate limit events when the call makes no sense, and keeps what they said', () => {
    const account = track()
    account.rateLimit(limit())
    const read = account.status().usage

    account.usageRead({ rate_limits: 'unexpected' })
    account.usageRead(answer({ five_hour: null, seven_day: null, seven_day_opus: null }))

    expect(account.status().usage).toEqual(read)
    expect(events).toHaveLength(1)
    expect(log.withMessage('usage call not understood: keeping the readings there are')).toHaveLength(2)
  })

  it('keeps the readings it has when the call says plan limits don’t apply', () => {
    const account = track()
    account.usageRead(answer())
    account.usageRead(answer(null, false))

    expect(account.status().usage).toEqual([SESSION, WEEK, OPUS])
    expect(events).toHaveLength(1)
    expect(log.withMessage('usage call: no plan limits apply')).toHaveLength(1)
  })

  it('updates one window from each rate limit event, keeping how much the call said was used', () => {
    const account = track()
    account.usageRead(answer())
    vi.advanceTimersByTime(MINUTE)

    // As each turn starts: the SDK says the session is fine, without saying how much is used.
    account.rateLimit(limit({ status: RateLimitStatus.Allowed, utilization: null, resetsAt: SESSION.resetsAt }))
    expect(account.status().usage).toEqual([{ ...SESSION, readAt: NOW + MINUTE }, WEEK, OPUS])

    account.rateLimit(limit({ window: UsageWindow.Weekly, utilization: 0.91, resetsAt: WEEK.resetsAt }))
    expect(account.status().usage[1]).toEqual({
      ...WEEK,
      utilization: 0.91,
      level: UsageLevel.Warning,
      readAt: NOW + MINUTE,
    })
    expect(events).toHaveLength(3)
  })

  it('reads nothing from an event for a window it doesn’t know', () => {
    const account = track()
    account.rateLimit(limit({ window: UsageWindow.Other }))

    expect(account.status().usage).toEqual([])
    expect(events).toEqual([])
    expect(log.withMessage('rate limit not read: an unknown window, or one already reset')).toHaveLength(1)
  })

  it('is at the limit once the SDK refuses requests, and back within it when it says so', () => {
    const account = track()
    account.rateLimit(limit({ status: RateLimitStatus.Rejected, utilization: null }))
    expect(account.status().usage[0]).toMatchObject({ utilization: null, level: UsageLevel.Limited })

    account.rateLimit(limit({ status: RateLimitStatus.Allowed, utilization: 0.02 }))
    expect(account.status().usage[0]).toMatchObject({ utilization: 0.02, level: UsageLevel.Within })
  })

  it('drops each reading when its window resets, and not a moment before', () => {
    const account = track()
    account.usageRead(answer())

    vi.advanceTimersByTime(2 * HOUR - 1)
    expect(account.status().usage).toEqual([SESSION, WEEK, OPUS])
    vi.advanceTimersByTime(1)
    expect(account.status().usage).toEqual([WEEK, OPUS])
    expect(events.at(-1)).toEqual({ type: EventType.AccountChanged, status: { account: null, usage: [WEEK, OPUS] } })
    expect(log.withMessage('usage readings over: their windows reset')[0]?.fields).toEqual({ count: 1 })

    // Both weekly windows reset at once.
    vi.advanceTimersByTime(4 * DAY)
    expect(account.status().usage).toEqual([])
    expect(events).toHaveLength(3)
  })

  it('times the newest reading’s reset, not the one it replaced', () => {
    const account = track()
    account.rateLimit(limit({ resetsAt: NOW + 1000 }))
    account.rateLimit(limit({ resetsAt: NOW + HOUR }))

    vi.advanceTimersByTime(1000)
    expect(account.status().usage).toHaveLength(1)
    vi.advanceTimersByTime(HOUR)
    expect(account.status().usage).toEqual([])
  })

  it('keeps a reading with no reset time until Claude Code says otherwise', () => {
    const account = track()
    account.rateLimit(limit({ resetsAt: null }))

    vi.advanceTimersByTime(30 * DAY)
    expect(account.status().usage).toMatchObject([{ resetsAt: null }])
  })

  it('waits out a window longer than one timer can', () => {
    const account = track()
    account.rateLimit(limit({ resetsAt: NOW + MAX_TIMER_MS + HOUR }))

    vi.advanceTimersByTime(MAX_TIMER_MS)
    expect(account.status().usage).toHaveLength(1)
    vi.advanceTimersByTime(HOUR)
    expect(account.status().usage).toEqual([])
  })

  it('shows the readings from before a relaunch again, dropping those whose window reset while it was closed', () => {
    replaceUsageReadings(database.db, [{ ...SESSION, resetsAt: NOW }, WEEK, { ...OPUS, resetsAt: null }])
    const account = track()
    expect(account.status().usage).toEqual([WEEK, { ...OPUS, resetsAt: null }])

    vi.advanceTimersByTime(4 * DAY)
    expect(account.status().usage).toEqual([{ ...OPUS, resetsAt: null }])
  })

  it('does nothing once closed', () => {
    const account = track()
    account.usageRead(answer())
    account.close()

    vi.advanceTimersByTime(4 * DAY)
    expect(listUsageReadings(database.db)).toEqual([SESSION, WEEK, OPUS])
  })
})
