/**
 * The agent backend of the app's test modes (e2e tests and screenshot captures). A test mode must never reach the real
 * Claude API, so the app never gives it the SDK backend, whatever it was started with (see `startApp`).
 *
 * A test mode's spec picks an agent script (`./scripts`) by name, and every session plays it (`./scripted-session`).
 * An e2e spec can also pick a script by a task's first message, so tasks run side by side can play different scripts.
 * With no script at all, starting a session fails loudly; with none for a session's first message, the session dies.
 */
import type { AgentBackend, AgentSession, AgentSessionOptions } from './backend'
import { ScriptedSession, type ScriptChooser } from './scripted-session'
import type { AgentScript } from './scripts'

/** An agent session was started in a test mode that has no script for it. */
export class UnscriptedAgentError extends Error {}

export interface TestModeAgentBackend extends AgentBackend {
  /**
   * Resolves once no session has anything left to play for now (every turn has ended or is waiting for Stop), and the
   * runner has handled what they streamed.
   */
  whenIdle(): Promise<void>
}

/** The scripts a test mode's sessions play. */
export interface TestModeScripts {
  /** What a session plays unless its first message picks another. */
  readonly script: AgentScript | null
  /** The script a session plays when its first message is exactly the key. */
  readonly byFirstMessage?: ReadonlyMap<string, AgentScript>
}

/** Picks a session's script by its first message, falling back on the default. */
function chooser({ script, byFirstMessage = new Map() }: TestModeScripts): ScriptChooser {
  return (firstMessage) => {
    const chosen = byFirstMessage.get(firstMessage) ?? script
    if (chosen === null) {
      throw new UnscriptedAgentError(`No agent script for a task whose first message is "${firstMessage}".`)
    }
    return chosen
  }
}

/**
 * A backend whose sessions play `scripts`, or fail loudly for none. A session's Glade tool calls run the real handlers
 * on its `glade` server, so they really change the task.
 */
export function createTestModeAgentBackend(scripts: TestModeScripts): TestModeAgentBackend {
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
      if (scripts.script === null && (scripts.byFirstMessage?.size ?? 0) === 0) {
        const error = new UnscriptedAgentError(
          `An agent session started in ${options.cwd} in a test mode, which never runs the real agent and has no agent script.`,
        )
        console.error(`Glade test mode: ${error.message}`)
        throw error
      }
      const session = new ScriptedSession({ script: chooser(scripts), session: options, onIdle: settle })
      return {
        messages: session.messages,
        send(text, uuid) {
          busy += 1
          session.send(text, uuid)
        },
        configure: (settings) => {
          session.configure(settings)
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
