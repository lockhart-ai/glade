/**
 * A session whose messages and settings wait on a gate (#448): a sandboxed session must have its overlay before the
 * agent reads anything, since whether its commands ask is in the overlay alone (`./sandbox`, `docs/sdk-notes.md` §15).
 * The backend already delivers what it's asked in order, but carries on after a change the SDK refuses; the gate is
 * what keeps a message from ever reaching a session whose overlay was refused.
 */
import type { AgentSession } from './backend'

/**
 * `session`, with every message sent and every settings change held until `ready` settles: delivered in the order
 * given once it's true, and dropped, all of them, if it's false. Everything else goes straight to the session.
 */
export function gatedSession(session: AgentSession, ready: Promise<boolean>): AgentSession {
  let gate = ready
  const whenReady = (step: () => void): void => {
    gate = gate.then((open) => {
      if (open) step()
      return open
    })
  }
  return {
    messages: session.messages,
    send(text, uuid, images) {
      whenReady(() => {
        session.send(text, uuid, images)
      })
    },
    configure(settings) {
      whenReady(() => {
        session.configure(settings)
      })
    },
    applyFlagSettings: (settings) => session.applyFlagSettings(settings),
    interrupt: () => session.interrupt(),
    stopTask: (sdkTaskId) => session.stopTask(sdkTaskId),
    contextUsage: () => session.contextUsage(),
    accountInfo: () => session.accountInfo(),
    usage: () => session.usage(),
    close() {
      session.close()
    },
  }
}
