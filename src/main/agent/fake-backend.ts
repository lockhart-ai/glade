// Test helper: an agent backend whose sessions stream whatever SDK messages a test scripts, and record what the runner
// asks of them. Nothing runs a model.
import { AsyncQueue } from './async-queue'
import type { AgentBackend, AgentSession, AgentSessionOptions } from './backend'

/** A message the runner sent a session. */
export interface SentMessage {
  readonly text: string
  readonly uuid: string
}

export class FakeAgentSession implements AgentSession {
  readonly sent: SentMessage[] = []
  interrupts = 0
  closed = false
  private readonly stream = new AsyncQueue<unknown>()
  readonly messages: AsyncIterable<unknown> = this.stream

  constructor(readonly options: AgentSessionOptions) {}

  send(text: string, uuid: string): void {
    this.sent.push({ text, uuid })
  }

  /** What the session does when interrupted, as the agent would: e.g. stream an aborted turn. Nothing by default. */
  onInterrupt: () => Promise<void> = () => Promise.resolve()

  interrupt(): Promise<void> {
    this.interrupts += 1
    return this.onInterrupt()
  }

  close(): void {
    this.closed = true
    this.stream.end()
  }

  /** Streams SDK messages to the runner, as the agent would. */
  emit(...messages: readonly unknown[]): void {
    for (const message of messages) this.stream.push(message)
  }

  /** Ends the stream, as a session whose process exited would. */
  end(): void {
    this.stream.end()
  }

  /** Fails the stream, as a session whose process crashed would. */
  fail(error: Error): void {
    this.stream.fail(error)
  }
}

export class FakeAgentBackend implements AgentBackend {
  readonly sessions: FakeAgentSession[] = []

  start(options: AgentSessionOptions): FakeAgentSession {
    const session = new FakeAgentSession(options)
    this.sessions.push(session)
    return session
  }

  /** The session started last. Throws if none has been. */
  get session(): FakeAgentSession {
    const session = this.sessions.at(-1)
    if (session === undefined) throw new Error('No agent session has started')
    return session
  }
}

/** Waits until the runner has handled everything streamed so far. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
