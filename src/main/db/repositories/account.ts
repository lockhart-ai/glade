// The account the tasks run on, and the warning while it's close to a usage limit (migration 31): one row each at
// most, `id` 1. See `src/shared/account.ts`.
import type { Database } from 'better-sqlite3'
import { UsageWindow, type Account, type UsageWarning } from '../../../shared/account'
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

/** The warning while a usage limit is close, or null when there's none. */
export function getUsageWarning(db: Database): UsageWarning | null {
  const raw: unknown = db.prepare('SELECT * FROM usage_warning WHERE id = 1').get()
  if (raw === undefined) return null
  const row = new Row('usage_warning', raw)
  return {
    utilization: row.nullableReal('utilization'),
    window: row.oneOf('usage_window', Object.values(UsageWindow)),
    resetsAt: row.nullableInteger('resets_at'),
  }
}

/** Stores the warning, in place of any before it; null clears it. */
export function setUsageWarning(db: Database, warning: UsageWarning | null): void {
  if (warning === null) {
    db.prepare('DELETE FROM usage_warning').run()
    return
  }
  db.prepare(
    `INSERT INTO usage_warning (id, utilization, usage_window, resets_at) VALUES (1, @utilization, @window, @resetsAt)
    ON CONFLICT (id) DO UPDATE SET utilization = excluded.utilization, usage_window = excluded.usage_window,
      resets_at = excluded.resets_at`,
  ).run(warning)
}
