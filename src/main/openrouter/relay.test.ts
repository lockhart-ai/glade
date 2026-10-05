import { afterEach, expect, it, vi, type Mock } from 'vitest'
import { z } from 'zod'
import { createOpenRouterRelay, type OpenRouterRelay } from './relay'
import { SAMPLE_CHOICE } from '../../shared/test-openrouter'
import { openRouterSdkModel } from './sdk-model'
import { createMemoryLog } from '../logging/memory-sink'
import { LogScope } from '../logging/logger'

it('preserves bounded thinking/signature diagnostics, redacts credentials, explains empty credit and logs errors', async () => {
  const log = createMemoryLog(LogScope.Agent)
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { error: { message: `Invalid signature in thinking block; private-key ${'x'.repeat(3000)}` } },
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(new Response('not JSON', { status: 402 }))
  const relay = await createOpenRouterRelay({
    choices: [SAMPLE_CHOICE],
    key: () => 'private-key',
    request,
    log: log.logger,
  })
  relays.push(relay)
  const failure = await post(relay, { model: SAMPLE_CHOICE.id })
  const body = z.object({ error: z.object({ message: z.string() }) }).parse(await failure.json())
  expect(body.error.message).toContain('Invalid signature in thinking block; [redacted]')
  expect(body.error.message).toHaveLength(2048)
  expect(await (await post(relay, { model: SAMPLE_CHOICE.id })).text()).toContain('insufficient credits')
  expect(log.withMessage('OpenRouter inference failed')).toHaveLength(2)
  expect(JSON.stringify(log.withMessage('OpenRouter inference failed'))).not.toContain('private-key')
})

const relays: OpenRouterRelay[] = []
interface RecordedBody {
  readonly output_config?: unknown
  [key: string]: unknown
}
function sentBody(request: Mock<typeof fetch>): RecordedBody {
  const body = z.string().parse(request.mock.calls[0]?.[1]?.body)
  return z.record(z.string(), z.unknown()).parse(JSON.parse(body) as unknown)
}
afterEach(() => {
  relays.splice(0).forEach((relay) => {
    relay.close()
  })
})

async function post(relay: OpenRouterRelay, body: unknown): Promise<Response> {
  return fetch(`${relay.url}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${relay.token}` },
    body: JSON.stringify(body),
  })
}

it('routes separate child dispatches to their own enabled model/provider pairs without changing the parent route', async () => {
  const child = {
    ...SAMPLE_CHOICE,
    id: 'openrouter:sample/small@other-host',
    model: { ...SAMPLE_CHOICE.model, id: 'sample/small' },
    provider: { id: 'other-host', name: 'Other Host' },
  }
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('Echo'))
  const relay = await createOpenRouterRelay({ choices: [SAMPLE_CHOICE, child], key: () => 'key', request })
  relays.push(relay)
  for (const choice of [child, SAMPLE_CHOICE, child]) {
    // A new Response per call keeps the mock response's body readable.
    request.mockResolvedValueOnce(new Response('Echo'))
    expect(await (await post(relay, { model: openRouterSdkModel(choice.id) })).text()).toBe('Echo')
    const body = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(z.string().parse(request.mock.calls.at(-1)?.[1]?.body)))
    expect(body).toMatchObject({
      model: choice.model.id,
      provider: { only: [choice.provider.id], allow_fallbacks: false },
    })
  }
  expect((await post(relay, { model: 'openrouter:sample/not-enabled@other-host' })).status).toBe(400)
  expect(request).toHaveBeenCalledTimes(3)
})

it('pins models and hosting providers, preserves tool/history payloads, normalizes thinking and streams without inspecting each SSE frame', async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"gen-sample"}}\n\ndata: {"id":"gen-sample"}\n\ndata: {"id":"tool-call"}\n\ndata: {}\n\ndata: [DONE]\n\n'
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
  const onComplete = vi.fn()
  const relay = await createOpenRouterRelay({
    choices: [SAMPLE_CHOICE],
    key: () => 'upstream-key',
    request,
    onComplete,
  })
  relays.push(relay)
  const messages = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'export const answer = 42' }] },
  ]
  const response = await post(relay, {
    model: SAMPLE_CHOICE.id,
    messages,
    models: ['unapproved'],
    route: 'fallback',
    preset: 'unapproved',
    plugins: [{ id: 'web' }],
    transforms: ['middle-out'],
    unknown_extension: true,
    provider: { only: ['unapproved'], allow_fallbacks: true },
    stream: true,
    output_config: { effort: 'max', format: { type: 'json_schema' } },
  })
  expect(await response.text()).toBe(sse)
  expect(request.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/messages')
  expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer upstream-key' })
  expect(sentBody(request)).toMatchObject({
    model: SAMPLE_CHOICE.model.id,
    provider: { only: [SAMPLE_CHOICE.provider.id], allow_fallbacks: false },
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema' } },
    messages,
  })
  expect(sentBody(request).output_config).not.toHaveProperty('effort')
  for (const field of ['models', 'fallbacks', 'route', 'preset', 'plugins', 'transforms', 'unknown_extension'])
    expect(sentBody(request)).not.toHaveProperty(field)
  expect(onComplete).toHaveBeenCalledOnce()
})

it('keeps supported reasoning controls and forwards nonstreaming responses without exposing the account key', async () => {
  const choice = {
    ...SAMPLE_CHOICE,
    model: { ...SAMPLE_CHOICE.model, parameters: ['tools', 'reasoning', 'reasoning_effort'] },
  }
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ id: 'gen-json', content: [{ type: 'text', text: 'Echo' }] }))
  const relay = await createOpenRouterRelay({ choices: [choice], key: () => 'private-key', request })
  relays.push(relay)
  expect(
    await (
      await post(relay, {
        model: openRouterSdkModel(choice.id),
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      })
    ).json(),
  ).toMatchObject({ id: 'gen-json' })
  expect(sentBody(request)).toMatchObject({
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
  })
})

it('rejects wrong credentials, origins, methods, arbitrary routes, unknown models and malformed bodies locally', async () => {
  const request = vi.fn<typeof fetch>()
  const relay = await createOpenRouterRelay({ choices: [SAMPLE_CHOICE], key: () => 'key', request })
  relays.push(relay)
  expect((await fetch(`${relay.url}/v1/messages`, { method: 'POST' })).status).toBe(401)
  expect(
    (
      await fetch(`${relay.url}/v1/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${relay.token}`, Origin: 'https://untrusted.example' },
      })
    ).status,
  ).toBe(403)
  expect(
    (await fetch(`${relay.url}/v1/messages`, { headers: { Authorization: `Bearer ${relay.token}` } })).status,
  ).toBe(404)
  expect(
    (await fetch(`${relay.url}/other`, { method: 'POST', headers: { Authorization: `Bearer ${relay.token}` } })).status,
  ).toBe(404)
  expect((await post(relay, { model: 'unapproved/model' })).status).toBe(400)
  expect((await post(relay, {})).status).toBe(400)
  const images = await post(relay, {
    model: SAMPLE_CHOICE.id,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'sample' } }] }],
  })
  expect(images.status).toBe(400)
  expect(await images.text()).toContain('does not accept images')
  expect(request).not.toHaveBeenCalled()
})

it('reports source-specific errors, suppresses upstream secrets, and handles dropped or empty upstream responses', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: 'private-key; log in to Claude' }, { status: 401 }))
    .mockResolvedValueOnce(Response.json({}, { status: 403 }))
    .mockResolvedValueOnce(Response.json({}, { status: 429 }))
    .mockRejectedValueOnce(new Error('private-key from upstream'))
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
  const relay = await createOpenRouterRelay({ choices: [SAMPLE_CHOICE], key: () => 'private-key', request })
  relays.push(relay)
  const unauthorized = await post(relay, { model: SAMPLE_CHOICE.id })
  expect(unauthorized.status).toBe(400)
  expect(await unauthorized.text()).not.toMatch(/private-key|log in to Claude/)
  expect((await post(relay, { model: SAMPLE_CHOICE.id })).status).toBe(400)
  expect((await post(relay, { model: SAMPLE_CHOICE.id })).status).toBe(429)
  await expect(post(relay, { model: SAMPLE_CHOICE.id })).rejects.toThrow('fetch failed')
  expect(await (await post(relay, { model: SAMPLE_CHOICE.id })).text()).toBe('')
})

it('keeps transport failures retryable, logs their redacted cause and distinguishes a removed key from invalid input', async () => {
  const log = createMemoryLog(LogScope.Agent)
  const key = vi.fn(() => 'private-key')
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('DNS lookup failed private-key'))
  const relay = await createOpenRouterRelay({ choices: [SAMPLE_CHOICE], key, request, log: log.logger })
  relays.push(relay)
  await expect(post(relay, { model: SAMPLE_CHOICE.id })).rejects.toThrow('fetch failed')
  expect(JSON.stringify(log.withMessage('OpenRouter relay transport failed'))).toContain('DNS lookup failed [redacted]')
  key.mockImplementationOnce(() => {
    throw new Error('Key removed')
  })
  expect(await (await post(relay, { model: SAMPLE_CHOICE.id })).text()).toContain('key is no longer available')
  expect(request).toHaveBeenCalledOnce()
  request.mockResolvedValue(new Response('Echo'))
  const messages = [{ role: 'assistant', content: [{ type: 'tool_use', input: { type: 'image', content: 'data' } }] }]
  expect(await (await post(relay, { model: SAMPLE_CHOICE.id, messages })).text()).toBe('Echo')
  const nested = await post(relay, {
    model: SAMPLE_CHOICE.id,
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image' }] }] }],
  })
  expect(nested.status).toBe(400)
  expect(
    (
      await fetch(`${relay.url}/v1/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${relay.token}` },
        body: '{broken',
      })
    ).status,
  ).toBe(400)
})

it('bounds payload size and revokes in-flight requests when the SDK session closes', async () => {
  let called: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    called = resolve
  })
  const request = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
    called()
    await new Promise<void>((_, reject) =>
      init?.signal?.addEventListener(
        'abort',
        () => {
          reject(new Error('cancelled'))
        },
        { once: true },
      ),
    )
    return new Response()
  })
  const relay = await createOpenRouterRelay({ choices: [SAMPLE_CHOICE], key: () => 'key', request })
  relays.push(relay)
  expect((await post(relay, { model: SAMPLE_CHOICE.id, content: 'x'.repeat(32 * 1024 * 1024) })).status).toBe(413)
  const response = post(relay, { model: SAMPLE_CHOICE.id })
  // Closing the route deliberately makes the local fetch fail; observe it before revocation.
  const failed = expect(response).rejects.toThrow()
  await started
  relay.close()
  await failed
})

it('cancels upstream inference when the SDK disconnects', async () => {
  let started: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  let cancelled: () => void = () => undefined
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const request = vi.fn<typeof fetch>().mockImplementation(async (_, init) => {
    started()
    await new Promise<void>((_, reject) =>
      init?.signal?.addEventListener(
        'abort',
        () => {
          cancelled()
          reject(new Error('SDK disconnected'))
        },
        { once: true },
      ),
    )
    return new Response()
  })
  const relay = await createOpenRouterRelay({ choices: [SAMPLE_CHOICE], key: () => 'key', request })
  relays.push(relay)
  const controller = new AbortController()
  const response = fetch(`${relay.url}/v1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${relay.token}` },
    body: JSON.stringify({ model: SAMPLE_CHOICE.id }),
    signal: controller.signal,
  })
  const failed = expect(response).rejects.toThrow()
  await pending
  controller.abort()
  await failed
  await aborted
})
