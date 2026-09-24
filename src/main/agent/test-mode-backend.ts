/**
 * The agent backend of the app's test modes (e2e tests and screenshot captures). A test mode must never reach the real
 * Claude API, so the app never gives it the SDK backend, whatever it was started with (see `startApp`).
 *
 * The e2e specs don't script agent runs yet, so starting a session fails loudly. When they do, this is where the
 * scripted fake goes: one that streams realistic SDK messages (see `docs/sdk-notes.md`) for each spec.
 */
import type { AgentBackend } from './backend'

/** An agent session was started in a test mode, which has no agent to run it. */
export class UnscriptedAgentError extends Error {}

export function createTestModeAgentBackend(): AgentBackend {
  return {
    start({ cwd }) {
      const error = new UnscriptedAgentError(
        `An agent session started in ${cwd} in a test mode, which never runs the real agent and has no scripted one.`,
      )
      console.error(`Glade test mode: ${error.message}`)
      throw error
    },
  }
}
