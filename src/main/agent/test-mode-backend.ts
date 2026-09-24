/**
 * The agent backend of the app's test modes (e2e tests and screenshot captures). A test mode must never reach the real
 * Claude API, so the app never gives it the SDK backend, whatever it was started with (see `startApp`).
 *
 * A test mode's spec picks an agent script (`./scripts`) by name, and every session plays it (`./scripted-session`).
 * With no script, starting a session fails loudly.
 */
import type { AgentBackend, AgentSession, AgentSessionOptions } from './backend'
import { ScriptedSession, type GladeToolCaller } from './scripted-session'
import type { AgentScript } from './scripts'

/** An agent session was started in a test mode that has no script for it. */
export class UnscriptedAgentError extends Error {}

export interface TestModeAgentOptions {
  /** The script every session plays, or null for none. */
  readonly script: AgentScript | null
  readonly callGladeTool: GladeToolCaller
}

export interface TestModeAgentBackend extends AgentBackend {
  /**
   * Resolves once no session has anything left to play for now (every turn has ended or is waiting for Stop), and the
   * runner has handled what they streamed.
   */
  whenIdle(): Promise<void>
}

export function createTestModeAgentBackend({ script, callGladeTool }: TestModeAgentOptions): TestModeAgentBackend {
  let busy = 0
  let waiters: (() => void)[] = []
  const settle = (): void => {
    busy -= 1
    if (busy > 0) return
    const ready = waiters
    waiters = []
    // Let the runner handle what the sessions streamed first: it reads every buffered message before a macrotask runs.
    setImmediate(() => {
      for (const resolve of ready) resolve()
    })
  }

  return {
    start(options: AgentSessionOptions): AgentSession {
      if (script === null) {
        const error = new UnscriptedAgentError(
          `An agent session started in ${options.cwd} in a test mode, which never runs the real agent and has no agent script.`,
        )
        console.error(`Glade test mode: ${error.message}`)
        throw error
      }
      const session = new ScriptedSession({ script, session: options, callGladeTool, onIdle: settle })
      return {
        messages: session.messages,
        send(text, uuid) {
          busy += 1
          session.send(text, uuid)
        },
        interrupt: () => session.interrupt(),
        close: () => {
          session.close()
        },
      }
    },

    whenIdle() {
      return busy === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve))
    },
  }
}
