/** Offline catalog for capture/e2e modes. A test-mode app never reaches OpenRouter, even with a real key supplied. */
import { SAMPLE_CATALOG_RESPONSE, SAMPLE_PROVIDER, SAMPLE_USAGE_RESPONSE } from '../../shared/test-openrouter'
import type { CredentialCipher } from './service'

export const TEST_MODE_CIPHER: CredentialCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (key) => Buffer.from(`test-only:${key}`),
  decryptString: (key) => key.toString().replace('test-only:', ''),
}

export const testModeOpenRouterRequest: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input)
  if (new Headers(init?.headers).get('authorization') === 'Bearer invalid')
    return Promise.resolve(Response.json({}, { status: 401 }))
  switch (url.pathname) {
    case '/api/v1/key':
      return Promise.resolve(Response.json(SAMPLE_USAGE_RESPONSE))
    case '/api/v1/models/user':
    case '/api/v1/models':
      return Promise.resolve(Response.json(SAMPLE_CATALOG_RESPONSE))
    case '/api/v1/providers':
      return Promise.resolve(Response.json({ data: [{ slug: SAMPLE_PROVIDER.id, name: SAMPLE_PROVIDER.name }] }))
    case '/api/v1/guardrails':
      // A management key whose guardrails let the account use the sample provider only.
      return Promise.resolve(Response.json({ data: [{ allowed_providers: [SAMPLE_PROVIDER.id] }] }))
    case '/api/v1/models/sample/flash/endpoints':
      return Promise.resolve(
        Response.json({
          data: {
            endpoints: [
              {
                provider_name: SAMPLE_PROVIDER.name,
                tag: SAMPLE_PROVIDER.id,
                supported_parameters: ['tools'],
                context_length: 128_000,
                pricing: { prompt: '0.0000001', completion: '0.0000002' },
              },
            ],
          },
        }),
      )
    default:
      return Promise.resolve(Response.json({}, { status: 404 }))
  }
}
