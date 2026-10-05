/**
 * The escape battery's stand-in for the model (#516, `docs/escape-battery.md`): a server on this Mac that speaks just
 * enough of the Messages API for the bundled Claude Code to run a turn against it, and replays a fixed list of tool
 * calls. No real model, and nothing improvised: what it answers depends only on the list and on how far the
 * conversation it's asked about has got.
 *
 * - **Which conversation** a request belongs to is read from its first messages: the battery's own messages, and the
 *   prompts it gives its subagents, each carry a marker (`[[battery:main]]`). A request with none (anything Claude
 *   Code asks on the side) is answered with a short text, and noted.
 * - **Which step** comes next is the number of turns the model has already had in the request, so a request sent twice
 *   gets the same answer. Each step is one tool call, or a line of text that ends the turn.
 * - **Everything the model would see comes back through here:** each tool call's result is in the next request. The
 *   stand-in keeps each result by its call, and notes every watched token (a canary's) that turns up anywhere in a
 *   request.
 *
 * It also checks what it's sent with: the key that is no key (`STAND_IN_API_KEY`) and no other login.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { STAND_IN_API_KEY } from '../../src/main/agent/stand-in'

/** What a tool call was given back: its result's text, and whether it was an error. */
export interface ToolResult {
  readonly text: string
  readonly isError: boolean
}

/** The results so far, by the id of the step that made the call. */
export type Results = ReadonlyMap<string, ToolResult>

/** A tool's input, or how to make it from the results so far (a path an earlier call's result gave, say). */
export type StepInput = Readonly<Record<string, unknown>> | ((results: Results) => Readonly<Record<string, unknown>>)

/** What a step of a conversation is. */
export enum StepKind {
  /** The model calls a tool. */
  Tool = 'tool',
  /** The model says something, and its turn ends. */
  Say = 'say',
}

/** A step in which the model calls one tool. */
export interface ToolStep {
  readonly kind: StepKind.Tool
  /** Names the step: letters, digits, `-` and `_`. The call's `tool_use` id is made of it. */
  readonly id: string
  readonly tool: string
  readonly input: StepInput
  /** A gate to wait at before the call is sent: something the spec does first (`StandIn.onGate`). */
  readonly gate?: string
}

/** A step in which the model says something, which ends its turn. */
export interface SayStep {
  readonly kind: StepKind.Say
  readonly text: string
}

export type Step = ToolStep | SayStep

/** A conversation the stand-in plays: the battery's own, or one of its subagents'. */
export interface Conversation {
  /** What the conversation's first message carries, e.g. `[[battery:main]]`. */
  readonly marker: string
  readonly steps: readonly Step[]
}

/** What the model says once a conversation has run out of steps: a turn nobody planned (a notification's, say). */
export const OUT_OF_STEPS = 'Nothing further.'

/** What the stand-in answers a request that is no part of a conversation it plays. */
export const SIDE_REPLY = 'ok'

const contentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
})

const message = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(contentBlock)]),
})

const messagesRequest = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(message),
})

type Message = z.infer<typeof message>

/** Where Claude Code tells the model how the session's sandbox is set up, in the conversation's opening. */
const SANDBOX_DESCRIPTION = /How the sandbox is configured in this session:\n([\s\S]*?)(?:\n\n|<\/system-reminder>|$)/

/** The `tool_use` id of a step's call. */
export function toolUseId(stepId: string): string {
  return `toolu_battery_${stepId.replaceAll('-', '_')}`
}

/** A message's text: its own, or its text blocks' joined. */
function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content.map((block) => block.text ?? '').join('\n')
}

/** A tool result's text: a string, or its text blocks' joined; anything else as JSON. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  const blocks = z.array(contentBlock).safeParse(content)
  if (blocks.success) return blocks.data.map((block) => block.text ?? '').join('\n')
  return JSON.stringify(content ?? '')
}

/** The events of one streamed reply. */
function streamed(model: string, id: string, step: Step, results: Results): unknown[] {
  const start = {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  }
  const stop = (reason: string): unknown[] => [
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]
  switch (step.kind) {
    case StepKind.Say:
      return [
        start,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } },
        ...stop('end_turn'),
      ]
    case StepKind.Tool: {
      const input = typeof step.input === 'function' ? step.input(results) : step.input
      return [
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolUseId(step.id), name: step.tool, input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
        },
        ...stop('tool_use'),
      ]
    }
  }
}

/** A request's body, read whole. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

/** Starts `server` on a free port of this Mac's loopback address, and answers with the port. */
export function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** The stand-in model: see the module comment. */
export class StandIn {
  private readonly server: Server
  private conversations: readonly Conversation[] = []
  private watched: readonly string[] = []
  private readonly gates = new Map<string, () => Promise<void>>()
  private readonly passedGates = new Map<string, Promise<void>>()
  private readonly kept = new Map<string, ToolResult>()
  private readonly seenTokens = new Set<string>()
  private port = 0
  private replies = 0
  private lastCall: string | null = null

  /** What was wrong with a request: a login other than the stand-in's key, or a body that isn't a Messages request. */
  readonly problems: string[] = []
  /** The requests that weren't for a message: nothing Claude Code needs here, so each is noted (`METHOD path`). */
  readonly strays: string[] = []
  /** How many requests were no part of a conversation, and were answered `SIDE_REPLY`. */
  sideRequests = 0
  /**
   * How Claude Code described the sandbox to the model, as the conversation's opening had it: what commands may read
   * and write, and reach. Null until a conversation starts, or if it said nothing.
   */
  sandboxDescription: string | null = null

  constructor() {
    this.server = createServer((request, response) => {
      this.answer(request, response).catch((error: unknown) => {
        this.problems.push(`the stand-in failed on a request: ${String(error)}`)
        response.writeHead(500).end()
      })
    })
  }

  async start(): Promise<void> {
    this.port = await listenOnLoopback(this.server)
  }

  /** Plays `conversations` from here on, and watches every request for `watched` (the canaries' tokens). */
  play(conversations: readonly Conversation[], watched: readonly string[]): void {
    this.conversations = conversations
    this.watched = watched
  }

  /** The stand-in's address, as the app is told it: `http://127.0.0.1:<port>`. */
  get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`
  }

  /** What `gate` waits on: run once, the first time a step with that gate comes up, before its call is sent. */
  onGate(gate: string, run: () => Promise<void>): void {
    this.gates.set(gate, run)
  }

  /** Each tool call's result so far, by its step's id. */
  get results(): Results {
    return this.kept
  }

  /** The watched tokens that have turned up in any request: what the model would have seen. */
  get sightings(): ReadonlySet<string> {
    return this.seenTokens
  }

  /**
   * The step whose call is running now: the last one sent, until its result comes back. What arrives somewhere it
   * shouldn't meanwhile, without saying whose it is (a TLS handshake at a listener, say), is that call's.
   */
  readonly during = (): string | null =>
    this.lastCall !== null && !this.kept.has(this.lastCall) ? this.lastCall : null

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve()
      })
      this.server.closeAllConnections()
    })
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request)
    const path = request.url ?? ''
    const key = request.headers['x-api-key']
    const authorization = request.headers.authorization
    if (
      !(key === STAND_IN_API_KEY && authorization === undefined) &&
      !(authorization === `Bearer ${STAND_IN_API_KEY}` && (key === undefined || key === STAND_IN_API_KEY))
    ) {
      this.problems.push(`a request came with a login that isn't the stand-in's key: ${request.method ?? ''} ${path}`)
    }
    for (const token of this.watched) if (body.includes(token)) this.seenTokens.add(token)
    if (request.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(path)) {
      this.strays.push(`${request.method ?? ''} ${path}`)
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not played here.' } }))
      return
    }
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      json = null
    }
    const parsed = messagesRequest.safeParse(json)
    if (!parsed.success) {
      this.problems.push(`a request for a message had a body the stand-in can't read: ${parsed.error.message}`)
      response.writeHead(400).end()
      return
    }
    const { model, messages, stream } = parsed.data
    const step = await this.nextStep(messages)
    this.replies += 1
    const id = `msg_battery_${String(this.replies)}`
    const events = streamed(model, id, step, this.kept)
    if (stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const event of events) {
        response.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      response.end()
      return
    }
    // Not streamed: only a side request asks that way, and its answer is text.
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: step.kind === StepKind.Say ? step.text : SIDE_REPLY }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    )
  }

  /** The step a request gets: its conversation's next, once any gate before it has been passed. */
  private async nextStep(messages: readonly Message[]): Promise<Step> {
    const opening = messages
      .slice(0, 2)
      .map(({ content }) => textOf(content))
      .join('\n')
    const conversation = this.conversations.find(({ marker }) => opening.includes(marker))
    if (conversation === undefined) {
      this.sideRequests += 1
      return { kind: StepKind.Say, text: SIDE_REPLY }
    }
    // The calls made so far, and the results that came back for them.
    const called: string[] = []
    const answered = new Set<string>()
    for (const { role, content } of messages) {
      if (typeof content === 'string') continue
      for (const block of content) {
        if (role === 'assistant' && block.type === 'tool_use' && block.id !== undefined) called.push(block.id)
        if (block.type === 'tool_result' && block.tool_use_id !== undefined) {
          answered.add(block.tool_use_id)
          this.keep(conversation, block.tool_use_id, resultText(block.content), block.is_error === true)
        }
      }
    }
    // A copy of the conversation cut off mid-call (Claude Code summarising a subagent's progress, say) isn't a turn.
    if (called.some((id) => !answered.has(id))) {
      this.sideRequests += 1
      return { kind: StepKind.Say, text: SIDE_REPLY }
    }
    this.sandboxDescription ??= SANDBOX_DESCRIPTION.exec(opening)?.[1]?.trim() ?? null
    const index = messages.filter(({ role }) => role === 'assistant').length
    const step = conversation.steps[index]
    if (step === undefined) return { kind: StepKind.Say, text: OUT_OF_STEPS }
    if (step.kind === StepKind.Tool && step.gate !== undefined) await this.passGate(step.gate)
    if (step.kind === StepKind.Tool) this.lastCall = step.id
    return step
  }

  private keep(conversation: Conversation, id: string, text: string, isError: boolean): void {
    const step = conversation.steps.find((step) => step.kind === StepKind.Tool && toolUseId(step.id) === id)
    if (step?.kind === StepKind.Tool) this.kept.set(step.id, { text, isError })
  }

  private passGate(gate: string): Promise<void> {
    const passed = this.passedGates.get(gate)
    if (passed !== undefined) return passed
    const run = this.gates.get(gate)
    const passing = run === undefined ? Promise.reject(new Error(`No one waits at the gate ${gate}`)) : run()
    this.passedGates.set(gate, passing)
    return passing
  }
}

/** A request the dead end refused. */
export interface Refused {
  /** Where it was going: `CONNECT host:port`, or a plain request's method and URL. */
  readonly request: string
  /** The step whose call was running when it came, or null. */
  readonly during: string | null
}

/**
 * The dead end every request for another host goes to: the proxy the app gives a session on a stand-in
 * (`standInEnv`). It refuses each request and notes where it was going, so whatever Claude Code's own process sends
 * past this Mac (a `WebFetch`, telemetry, the real API) is seen, and goes nowhere.
 */
export class DeadEnd {
  private readonly server: Server
  private port = 0
  /** Each refused request, oldest first. */
  readonly requests: Refused[] = []

  /** `during` names the call running when a request comes (`StandIn.during`). */
  constructor(during: () => string | null) {
    this.server = createServer((request, response) => {
      this.requests.push({ request: `${request.method ?? ''} ${request.url ?? ''}`, during: during() })
      response.writeHead(403).end()
    })
    this.server.on('connect', (request, socket) => {
      this.requests.push({ request: `CONNECT ${request.url ?? ''}`, during: during() })
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
  }

  async start(): Promise<void> {
    this.port = await listenOnLoopback(this.server)
  }

  /** The proxy's address, as the app is told it: `http://127.0.0.1:<port>`. */
  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve()
      })
      this.server.closeAllConnections()
    })
  }
}
