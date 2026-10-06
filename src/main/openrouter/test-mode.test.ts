import { expect, it } from 'vitest'
import { TEST_MODE_CIPHER, testModeOpenRouterRequest } from './test-mode'

it('keeps test and capture catalog requests offline, including invalid credentials and unknown paths', async () => {
  expect(TEST_MODE_CIPHER.isEncryptionAvailable()).toBe(true)
  expect(TEST_MODE_CIPHER.decryptString(TEST_MODE_CIPHER.encryptString('sample-key'))).toBe('sample-key')
  for (const path of ['key', 'models/user', 'models', 'providers', 'models/sample/flash/endpoints']) {
    expect((await testModeOpenRouterRequest(`https://openrouter.ai/api/v1/${path}`)).status).toBe(200)
  }
  expect(
    (
      await testModeOpenRouterRequest('https://openrouter.ai/api/v1/models/user', {
        headers: { Authorization: 'Bearer invalid' },
      })
    ).status,
  ).toBe(401)
  expect((await testModeOpenRouterRequest('https://openrouter.ai/api/v1/unknown')).status).toBe(404)
})
