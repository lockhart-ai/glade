import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { z } from 'zod'
import type { OpenRouterChoice } from '../../shared/openrouter'
import { openRouterSdkModel } from './sdk-model'

interface RelayMessageRequest {
  readonly model: string
  readonly stream?: boolean
  readonly output_config?: Readonly<Record<string, unknown>>
  [key: string]: unknown
}

const requestSchema = z
  .object({
    model: z.string(),
    stream: z.boolean().optional(),
    output_config: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown()) satisfies z.ZodType<RelayMessageRequest>

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage)
  if (value === null || typeof value !== 'object') return false
  const fields = z.record(z.string(), z.unknown()).parse(value)
  return fields.type === 'image' || Object.values(fields).some(containsImage)
}

export interface OpenRouterRelayOptions {
  readonly choices: readonly OpenRouterChoice[]
  readonly key: () => string
  readonly request?: typeof fetch
  readonly onGeneration?: (id: string, choice: OpenRouterChoice) => void
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
  const request = options.request ?? fetch
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
      const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
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
      const upstreamBody: RelayMessageRequest = {
        ...body,
        model: choice.model.id,
        provider: { only: [choice.provider.id], allow_fallbacks: false },
        output_config: output,
        ...(!choice.model.parameters.includes('reasoning') ? { thinking: { type: 'disabled' } } : {}),
      }
      // These OpenRouter extras can bypass a pinned model through request-level fallbacks or presets.
      delete upstreamBody.models
      delete upstreamBody.fallbacks
      delete upstreamBody.route
      delete upstreamBody.preset
      const upstream = await request('https://openrouter.ai/api/v1/messages', {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${options.key()}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'X-OpenRouter-Title': 'Glade',
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]),
      })
      if (!upstream.ok) {
        // Never forward provider errors containing credentials or Claude-login instructions.
        failure(
          response,
          upstream.status === 401 || upstream.status === 403 ? 400 : upstream.status,
          `OpenRouter returned ${String(upstream.status)}. Check Settings → Models, the selected provider and key restrictions.`,
        )
        return
      }
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      const ids = new Set<string>()
      const decoder = new TextDecoder()
      let buffer = ''
      const generation = (raw: string): void => {
        try {
          const event = z
            .object({ id: z.string().optional(), message: z.object({ id: z.string().optional() }).optional() })
            .parse(JSON.parse(raw) as unknown)
          const id = event.message?.id ?? event.id
          if (id !== undefined && id.startsWith('gen-') && !ids.has(id)) {
            ids.add(id)
            options.onGeneration?.(id, choice)
          }
        } catch {
          // SSE keepalives and [DONE] have no generation metadata.
        }
      }
      if (upstream.body !== null) {
        for await (const rawChunk of upstream.body) {
          const chunk = z.instanceof(Uint8Array).parse(rawChunk)
          buffer += decoder.decode(chunk, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) if (line.startsWith('data: ')) generation(line.slice(6))
          if (buffer.length > 64_000) buffer = ''
          if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal })
        }
      }
      if (buffer !== '') generation(buffer)
      options.onComplete?.()
      response.end()
    } catch {
      if (response.headersSent) response.destroy()
      else failure(response, 400, 'The OpenRouter request failed. Check the connection in Settings → Models.')
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
