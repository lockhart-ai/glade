import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { z } from 'zod'
import type { OpenRouterChoice } from '../../shared/openrouter'
import { openRouterSdkModel } from './sdk-model'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

interface RelayMessageRequest {
  readonly model: string
  readonly stream?: boolean
  readonly output_config?: Readonly<Record<string, unknown>>
  readonly messages?: unknown
  readonly max_tokens?: unknown
  readonly metadata?: unknown
  readonly stop_sequences?: unknown
  readonly system?: unknown
  readonly temperature?: unknown
  readonly top_k?: unknown
  readonly top_p?: unknown
  readonly tools?: unknown
  readonly tool_choice?: unknown
  readonly thinking?: unknown
  readonly service_tier?: unknown
}

const requestSchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  output_config: z.record(z.string(), z.unknown()).optional(),
  messages: z.unknown().optional(),
  max_tokens: z.unknown().optional(),
  metadata: z.unknown().optional(),
  stop_sequences: z.unknown().optional(),
  system: z.unknown().optional(),
  temperature: z.unknown().optional(),
  top_k: z.unknown().optional(),
  top_p: z.unknown().optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  thinking: z.unknown().optional(),
  service_tier: z.unknown().optional(),
}) satisfies z.ZodType<RelayMessageRequest>

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage)
  if (value === null || typeof value !== 'object') return false
  if ('type' in value && value.type === 'image') return true
  // Inspect message and tool-result content, never arbitrary tool inputs that happen to name an image.
  return 'content' in value && containsImage(value.content)
}

export interface OpenRouterRelayOptions {
  readonly choices: readonly OpenRouterChoice[]
  readonly key: () => string
  readonly request: typeof fetch
  readonly log?: Logger
  readonly onComplete?: () => void
}

export interface OpenRouterRelay {
  readonly url: string
  /** Short-lived relay credential, never the OpenRouter key. */
  readonly token: string
  close(): void
}

function failure(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
}

/** Only the local SDK can reach this route. Provider, fallback policy and models are main-owned. */
export async function createOpenRouterRelay(options: OpenRouterRelayOptions): Promise<OpenRouterRelay> {
  const token = randomBytes(32).toString('hex')
  const controllers = new Set<AbortController>()
  const request = options.request
  const log = options.log ?? SILENT_LOGGER
  const serve = async (incoming: IncomingMessage, response: ServerResponse): Promise<void> => {
    const auth = Buffer.from(incoming.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      failure(response, 401, 'Invalid Glade session credential.')
      return
    }
    if (incoming.headers.origin !== undefined) {
      failure(response, 403, 'Browser requests cannot use a Glade inference route.')
      return
    }
    // The SDK adds ?beta=true. Query fields never affect the fixed upstream route.
    if (incoming.method !== 'POST' || incoming.url?.split('?')[0] !== '/v1/messages') {
      failure(response, 404, 'This Glade route only accepts Messages requests.')
      return
    }
    const controller = new AbortController()
    controllers.add(controller)
    const disconnect = (): void => {
      if (!response.writableEnded) controller.abort()
    }
    response.on('close', disconnect)
    let key = ''
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of incoming) {
        const bytes = z.instanceof(Buffer).parse(chunk)
        size += bytes.length
        if (size > 32 * 1024 * 1024) {
          failure(response, 413, 'OpenRouter request is too large.')
          return
        }
        chunks.push(bytes)
      }
      const parsedBody = requestSchema.safeParse(
        await Promise.resolve()
          .then(() => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
          .catch(() => null),
      )
      if (!parsedBody.success) {
        failure(response, 400, 'Invalid Messages request.')
        return
      }
      const body = parsedBody.data
      const choice = options.choices.find(({ id }) => id === body.model || openRouterSdkModel(id) === body.model)
      if (choice === undefined) {
        failure(response, 400, 'This model is not enabled for the Glade session.')
        return
      }
      if (!choice.model.inputs.includes('image') && containsImage(body.messages)) {
        failure(
          response,
          400,
          'This OpenRouter model does not accept images. Choose an image-capable model to continue this history.',
        )
        return
      }
      // Translate the SDK's Messages effort. Leave structured output fields intact.
      const output = { ...body.output_config }
      if (!choice.model.parameters.includes('reasoning_effort')) delete output.effort
      const upstreamBody = {
        ...body,
        model: choice.model.id,
        provider: { only: [choice.provider.id], allow_fallbacks: false },
        output_config: output,
        ...(!choice.model.parameters.includes('reasoning') ? { thinking: { type: 'disabled' } } : {}),
      }
      // The schema strips all non-Messages fields, including plugins, transforms and future routing extensions.
      try {
        key = options.key()
      } catch {
        log.warn('OpenRouter inference key unavailable')
        failure(response, 400, 'The OpenRouter key is no longer available. Connect it in Settings → Models.')
        return
      }
      const upstream = await request('https://openrouter.ai/api/v1/messages', {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'X-OpenRouter-Title': 'Glade',
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]),
      })
      if (!upstream.ok) {
        const parsed = z
          .object({ error: z.object({ message: z.string() }) })
          .safeParse(await upstream.json().catch(() => null))
        const fallback =
          upstream.status === 402
            ? 'OpenRouter has insufficient credits. Add credits or check this key’s spending limit.'
            : `OpenRouter returned ${String(upstream.status)}. Check Settings → Models, the selected provider and key restrictions.`
        // Preserve provider diagnostics used by the SDK's thinking/signature recovery, with bounded redacted text.
        const message = (parsed.success ? parsed.data.error.message : fallback)
          .split(key)
          .join('[redacted]')
          .split(token)
          .join('[redacted]')
          .slice(0, 2048)
        log.warn('OpenRouter inference failed', { status: upstream.status, message })
        options.onComplete?.()
        failure(response, upstream.status === 401 || upstream.status === 403 ? 400 : upstream.status, message)
        return
      }
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      if (upstream.body !== null) {
        for await (const rawChunk of upstream.body) {
          const chunk = z.instanceof(Uint8Array).parse(rawChunk)
          if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal })
        }
      }
      options.onComplete?.()
      response.end()
    } catch (error) {
      const reason = (error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown transport failure')
        .split(key || token)
        .join('[redacted]')
        .split(token)
        .join('[redacted]')
        .slice(0, 2048)
      log.warn('OpenRouter relay transport failed', { reason })
      // A connection error lets the SDK retry, then reach Glade's Offline flow if it persists.
      response.destroy()
    } finally {
      controllers.delete(controller)
      response.off('close', disconnect)
    }
  }
  const server = createServer((incoming, response) => {
    void serve(incoming, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  // A TCP listener bound above has a numeric port; reject an unexpected platform result at the boundary.
  const address = z.object({ port: z.number().int().positive() }).parse(server.address())
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    token,
    close() {
      controllers.forEach((controller) => {
        controller.abort()
      })
      server.closeAllConnections()
      server.close()
    },
  }
}
