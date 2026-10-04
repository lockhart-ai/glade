// The account the tasks run on (migration 33: one row at most, `id` 1), and the latest reading of each of its usage
// limits (migration 42: one row per limit; migration 61: what the usage call says of extra usage, with its reading).
// See `src/shared/account.ts`.
import type { Database } from 'better-sqlite3'
import {
  sortUsageReadings,
  UsageLevel,
  UsageLimitKind,
  type Account,
  type ExtraUsageStatus,
  type UsageLimit,
  type UsageReading,
} from '../../../shared/account'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

/** The account as last read, or null when none has been read yet. */
export function getAccount(db: Database): Account | null {
  const raw: unknown = db.prepare('SELECT * FROM account WHERE id = 1').get()
  if (raw === undefined) return null
  const row = new Row('account', raw)
  return {
    email: row.nullableText('email'),
    organization: row.nullableText('organization'),
    subscriptionType: row.nullableText('subscription_type'),
    tokenSource: row.nullableText('token_source'),
    apiKeySource: row.nullableText('api_key_source'),
    apiProvider: row.nullableText('api_provider'),
    readAt: row.integer('read_at'),
  }
}

/** Stores the account as just read, in place of the one before. */
export function saveAccount(db: Database, account: Account): void {
  db.prepare(
    `INSERT INTO account (id, email, organization, subscription_type, token_source, api_key_source, api_provider,
      read_at)
    VALUES (1, @email, @organization, @subscriptionType, @tokenSource, @apiKeySource, @apiProvider, @readAt)
    ON CONFLICT (id) DO UPDATE SET email = excluded.email, organization = excluded.organization,
      subscription_type = excluded.subscription_type, token_source = excluded.token_source,
      api_key_source = excluded.api_key_source, api_provider = excluded.api_provider, read_at = excluded.read_at`,
  ).run(account)
}

/** A limit's row key: its kind, and the model's name for a per-model one (empty for the others). */
interface LimitRowKey {
  readonly kind: UsageLimitKind
  readonly model: string
}

function limitRowKey(limit: UsageLimit): LimitRowKey {
  return { kind: limit.kind, model: limit.kind === UsageLimitKind.WeeklyModel ? limit.model : '' }
}

/** What a row keeps of extra usage (`ExtraUsageStatus`), or undefined for a row that keeps none of it. */
function extraUsageFrom(row: Row): ExtraUsageStatus | undefined {
  const available = row.nullableInteger('extra_available')
  if (available === null) return undefined
  const spent = row.nullableReal('spent')
  return {
    available: available === 1,
    spend:
      spent === null
        ? null
        : {
            spent,
            cap: row.nullableReal('spend_cap'),
            currency: row.text('spend_currency'),
            decimalPlaces: row.integer('spend_decimal_places'),
          },
  }
}

function readingFrom(raw: unknown): UsageReading {
  const row = new Row('usage_readings', raw)
  const kind = row.oneOf('kind', Object.values(UsageLimitKind))
  const limit: UsageLimit = kind === UsageLimitKind.WeeklyModel ? { kind, model: row.text('model') } : { kind }
  const extraUsage = extraUsageFrom(row)
  return {
    limit,
    utilization: row.nullableReal('utilization'),
    resetsAt: row.nullableInteger('resets_at'),
    level: row.oneOf('level', Object.values(UsageLevel)),
    readAt: row.integer('read_at'),
    ...(extraUsage === undefined ? {} : { extraUsage }),
  }
}

/** The latest reading of each usage limit, in the meter's order; none until one is read. */
export function listUsageReadings(db: Database): UsageReading[] {
  return sortUsageReadings(db.prepare('SELECT * FROM usage_readings').all().map(readingFrom))
}

/** Stores a reading in place of its limit's last one. */
export function saveUsageReading(db: Database, reading: UsageReading): void {
  const { extraUsage } = reading
  const spend = extraUsage?.spend
  db.prepare(
    `INSERT INTO usage_readings (kind, model, utilization, resets_at, level, read_at, extra_available, spent,
      spend_cap, spend_currency, spend_decimal_places)
    VALUES (@kind, @model, @utilization, @resetsAt, @level, @readAt, @extraAvailable, @spent, @spendCap,
      @spendCurrency, @spendDecimalPlaces)
    ON CONFLICT (kind, model) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at,
      level = excluded.level, read_at = excluded.read_at, extra_available = excluded.extra_available,
      spent = excluded.spent, spend_cap = excluded.spend_cap, spend_currency = excluded.spend_currency,
      spend_decimal_places = excluded.spend_decimal_places`,
  ).run({
    ...limitRowKey(reading.limit),
    utilization: reading.utilization,
    resetsAt: reading.resetsAt,
    level: reading.level,
    readAt: reading.readAt,
    extraAvailable: extraUsage === undefined ? null : Number(extraUsage.available),
    spent: spend?.spent ?? null,
    spendCap: spend?.cap ?? null,
    spendCurrency: spend?.currency ?? null,
    spendDecimalPlaces: spend?.decimalPlaces ?? null,
  })
}

/** Stores `readings` in place of every reading before them, all at once. */
export function replaceUsageReadings(db: Database, readings: readonly UsageReading[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM usage_readings').run()
    for (const reading of readings) saveUsageReading(db, reading)
  })()
}

/** Drops the readings whose window has reset by `now`, and answers how many it dropped. */
export function deleteResetUsageReadings(db: Database, now: EpochMs): number {
  return db.prepare('DELETE FROM usage_readings WHERE resets_at IS NOT NULL AND resets_at <= ?').run(now).changes
}
