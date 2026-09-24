import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effort } from '../../../shared/domain'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { getSettings, updateSettings } from './settings'
import { openTestDatabase, type TestDatabase } from './test-database'

let test: TestDatabase

beforeEach(() => {
  test = openTestDatabase()
})

afterEach(() => {
  test.close()
})

describe('settings', () => {
  it('are the defaults until changed', () => {
    expect(getSettings(test.db)).toEqual(DEFAULT_SETTINGS)
  })

  it('store the settings a patch changes, keep the rest, and replace earlier values', () => {
    expect(updateSettings(test.db, { defaultEffort: Effort.Low, notifications: false })).toEqual({
      ...DEFAULT_SETTINGS,
      defaultEffort: Effort.Low,
      notifications: false,
    })

    const settings = updateSettings(test.db, { defaultModel: 'claude-sonnet-5', notifications: true })

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, defaultModel: 'claude-sonnet-5', defaultEffort: Effort.Low })
    expect(getSettings(test.db)).toEqual(settings)
  })

  it('skips an empty patch and keys set to undefined', () => {
    expect(updateSettings(test.db, { taskTitles: undefined })).toEqual(DEFAULT_SETTINGS)
    expect(test.db.prepare('SELECT COUNT(*) FROM settings').pluck().get()).toBe(0)
  })

  it('reads a stored value that is not valid JSON, is the wrong shape, or has an unknown key as the default', () => {
    const insert = test.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    insert.run('notifications', 'not json')
    insert.run('defaultEffort', '"extreme"')
    insert.run('taskTitles', '"yes"')
    insert.run('from_the_future', 'true')

    expect(getSettings(test.db)).toEqual(DEFAULT_SETTINGS)
  })
})
