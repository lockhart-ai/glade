import { describe, expect, it, vi } from 'vitest'
import { OpenRouterClient } from './client'
import { SAMPLE_CATALOG_RESPONSE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { SAMPLE_USAGE, SAMPLE_USAGE_RESPONSE } from '../../shared/test-openrouter'

it('reads USD key totals and nullable limits without returning credential labels or account identifiers', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        data: {
          ...SAMPLE_USAGE_RESPONSE.data,
          label: 'secret-label',
          creator_user_id: 'secret-account',
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: {
          ...SAMPLE_USAGE_RESPONSE.data,
          limit: null,
          limit_remaining: null,
          limit_reset: null,
          free_model_daily_requests: { used: 1, limit: 50, remaining: 49 },
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: { usage: -1 } }))
  const client = new OpenRouterClient(request)
  expect(await client.usage('private-key', 123)).toEqual({ ...SAMPLE_USAGE, readAt: 123 })
  expect(request.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/key')
  expect(await client.usage('private-key', 124)).toMatchObject({ limit: null, remaining: null, limitReset: null })
  await expect(client.usage('private-key', 125)).rejects.toThrow()
})

describe('OpenRouter discovery', () => {
  it('keeps endpoint-specific prices and context', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        data: {
          endpoints: [
            {
              provider_name: SAMPLE_PROVIDER.name,
              tag: SAMPLE_PROVIDER.id,
              supported_parameters: ['tools'],
              context_length: 64000,
              pricing: { prompt: '0.000001', completion: '0.000002' },
            },
          ],
        },
      }),
    )

    const client = new OpenRouterClient(request)
    expect(await client.endpoints('key', SAMPLE_MODEL.id, [SAMPLE_PROVIDER])).toEqual([
      {
        ...SAMPLE_PROVIDER,
        contextLength: 64000,
        inputPrice: '0.000001',
        outputPrice: '0.000002',
        parameters: ['tools'],
      },
    ])
  })
  it('reads key-filtered tool models and providers, ignoring models that cannot run agents', async () => {
    const model = SAMPLE_CATALOG_RESPONSE.data[0]
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [
            model,
            { ...model, id: 'image-only', architecture: { input_modalities: ['image'], output_modalities: ['image'] } },
            { ...model, id: 'text-image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
            { ...model, id: 'no-tools', supported_parameters: [] },
            { ...model, id: 'defaults', description: undefined, supported_parameters: undefined },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ slug: SAMPLE_PROVIDER.id, name: SAMPLE_PROVIDER.name }] }))
    const client = new OpenRouterClient(request)
    expect(await client.catalog('test-key')).toEqual({ models: [SAMPLE_MODEL], providers: [SAMPLE_PROVIDER] })
    expect(request.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/models/user')
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer test-key' },
      redirect: 'error',
    })
  })

  it('discovers only tool-capable hosting providers and encodes model paths', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: {
            endpoints: [
              { provider_name: 'Sample Host', tag: 'sample-host/turbo', supported_parameters: ['tools'] },
              { provider_name: 'Other', tag: 'other' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(SAMPLE_CATALOG_RESPONSE))
    const client = new OpenRouterClient(request)
    expect(
      await client.endpoints('key', 'sample/flash:free', [SAMPLE_PROVIDER, { id: 'other', name: 'Other' }]),
    ).toEqual([{ ...SAMPLE_PROVIDER, parameters: ['tools'] }])
    expect(request.mock.calls[0]?.[0]).toContain('models/sample/flash%3Afree/endpoints')
    expect(await client.providerModels('key', SAMPLE_PROVIDER)).toEqual([SAMPLE_MODEL.id])
    expect(request.mock.calls[1]?.[0]).toContain('providers=Sample%20Host')
  })

  it('rejects invalid keys and malformed catalog responses without including the key or account body', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ secret: 'not-for-renderer' }, { status: 401 }))
      .mockResolvedValue(Response.json({ data: [] }))
    await expect(new OpenRouterClient(request).endpoints('private-key', 'sample/flash', [])).rejects.toThrow(
      'OpenRouter returned 401',
    )
    await expect(new OpenRouterClient(request).endpoints('private-key', 'sample/flash', [])).rejects.toThrow()
  })
})
