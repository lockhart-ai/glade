// The HTTP endpoint's token: made once, kept in SQLite where the window's settings can't reach it, replaced on demand,
// and compared in constant time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeErrorCode, CommandName } from '../../shared/bridge'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { getSettings } from '../db/repositories/settings'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { startControlApp, type ControlApp } from './test-control'
import {
  CONTROL_TOKEN_KEY,
  ensureControlToken,
  newControlToken,
  readControlToken,
  regenerateControlToken,
  tokenMatches,
} from './token'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

function store(value: string): void {
  database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(CONTROL_TOKEN_KEY, value)
}

describe('a token', () => {
  it('is 32 random bytes, base64url, and never the same twice', () => {
    const tokens = Array.from({ length: 50 }, newControlToken)

    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    }
    expect(new Set(tokens).size).toBe(50)
  })
})

describe('the stored token', () => {
  it('is none until one is made, then the same one every time', () => {
    expect(readControlToken(database.db)).toBeNull()

    const token = ensureControlToken(database.db)

    expect(readControlToken(database.db)).toBe(token)
    expect(ensureControlToken(database.db)).toBe(token)
  })

  it('is replaced by a new one when regenerated', () => {
    const first = ensureControlToken(database.db)

    const second = regenerateControlToken(database.db)

    expect(second).not.toBe(first)
    expect(readControlToken(database.db)).toBe(second)
  })

  it.each([
    ['not JSON', 'nope'],
    ['not a string', '42'],
    ['not a token', JSON.stringify('short')],
  ])('reads as none when what is stored is %s, and a new one replaces it', (_what, value) => {
    store(value)

    expect(readControlToken(database.db)).toBeNull()
    const token = ensureControlToken(database.db)
    expect(readControlToken(database.db)).toBe(token)
  })

  it("isn't a setting: the settings read without it", () => {
    ensureControlToken(database.db)

    expect(getSettings(database.db)).toEqual(DEFAULT_SETTINGS)
  })
})

describe("the window's settings.update", () => {
  let app: ControlApp

  beforeEach(() => {
    app = startControlApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it("can't write the token", async () => {
    const token = ensureControlToken(app.database.db)

    await expect(
      app.glade.invoke(CommandName.SettingsUpdate, { patch: { [CONTROL_TOKEN_KEY]: 'mine' } as never }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    expect(readControlToken(app.database.db)).toBe(token)
  })
})

describe('tokenMatches', () => {
  it('matches the token itself only', () => {
    const token = newControlToken()

    expect(tokenMatches(token, token)).toBe(true)
    expect(tokenMatches(newControlToken(), token)).toBe(false)
    expect(tokenMatches(token.slice(0, -1), token)).toBe(false)
    expect(tokenMatches(`${token}x`, token)).toBe(false)
    expect(tokenMatches('', token)).toBe(false)
  })
})
