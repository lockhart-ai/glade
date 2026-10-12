import { expect, it } from 'vitest'
import { SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { TEST_MODE_CIPHER, testModeOpenRouterRequest } from './test-mode'

it('keeps test and capture catalog requests offline, including invalid credentials and unknown paths', async () => {
  expect(TEST_MODE_CIPHER.isEncryptionAvailable()).toBe(true)
  expect(TEST_MODE_CIPHER.decryptString(TEST_MODE_CIPHER.encryptString('sample-key'))).toBe('sample-key')
  for (const path of ['key', 'models/user', 'models', 'providers', 'guardrails', 'models/sample/flash/endpoints']) {
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

it('answers a management key’s guardrails with the sample provider as the only one allowed', async () => {
  const response = await testModeOpenRouterRequest('https://openrouter.ai/api/v1/guardrails')
  expect(await response.json()).toEqual({ data: [{ allowed_providers: [SAMPLE_PROVIDER.id] }] })
})
