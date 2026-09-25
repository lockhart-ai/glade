/**
 * The HTTP endpoint's bearer token (`docs/control-api.md`, "The HTTP endpoint"): 32 random bytes, base64url, made the
 * first time the switch goes on and kept in SQLite, and replaced when you regenerate it.
 *
 * It's a row in the settings table under a key that isn't a setting, so `settings.get` never answers with it and the
 * window's `settings.update`, whose request only takes the settings' own keys, can't write it. It's never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'

/** The settings table's key for the token. */
export const CONTROL_TOKEN_KEY = 'controlToken'

/** How many random bytes a token has. */
const TOKEN_BYTES = 32

/** A token as stored: JSON of a base64url string of `TOKEN_BYTES` bytes. */
export const storedToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** A new token. */
export function newControlToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** The stored token; null before the switch has first gone on, or when the stored value isn't a token. */
export function readControlToken(db: Database): string | null {
  const row: unknown = db.prepare('SELECT value FROM settings WHERE key = ?').get(CONTROL_TOKEN_KEY)
  const value = z.object({ value: z.string() }).safeParse(row)
  if (!value.success) return null
  let json: unknown
  try {
    json = JSON.parse(value.data.value)
  } catch {
    return null
  }
  const token = storedToken.safeParse(json)
  return token.success ? token.data : null
}

/** Stores `token`, replacing the one before. */
export function storeControlToken(db: Database, token: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(CONTROL_TOKEN_KEY, JSON.stringify(token))
}

/** The stored token, making and storing one first if there's none. */
export function ensureControlToken(db: Database): string {
  const existing = readControlToken(db)
  if (existing !== null) return existing
  const token = newControlToken()
  storeControlToken(db, token)
  return token
}

/** Replaces the token with a new one, and answers with it. */
export function regenerateControlToken(db: Database): string {
  const token = newControlToken()
  storeControlToken(db, token)
  return token
}

/** SHA-256 of a string: equal lengths, so comparing two of them in constant time reveals nothing of either's length. */
function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

/** Whether `given` is `token`, compared in constant time. */
export function tokenMatches(given: string, token: string): boolean {
  return timingSafeEqual(digest(given), digest(token))
}
