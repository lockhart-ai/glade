/**
 * The agent backend of the app's test modes (e2e tests and screenshot captures). A test mode must never reach the real
 * Claude API, so the app never gives it the SDK backend, whatever it was started with (see `startApp`).
 *
 * A test mode's spec picks an agent script (`./scripts`) by name, and every session plays it (`./scripted-session`).
 * An e2e spec can also pick a script by a task's first message, so tasks run side by side can play different scripts.
 * A session resumed on launch is first sent `RESUME_PROMPT`, not the task's first message, so it picks its script by
 * the first message of the task it resumes (`firstMessageOf`), and a relaunched task plays the script it played before.
 * With no script at all, starting a session fails loudly; with none for a session's first message, the session dies.
 * Nothing is spawned, but each session reports the environment a real one's agent process would have run in.
 */
import type { Environment } from '../login-env'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { AgentBackend, AgentSession, AgentSessionOptions } from './backend'
import { ScriptedSession, type ScriptChooser } from './scripted-session'
import { userContent, type UserContent } from './user-content'
import type { AgentScript } from './scripts'

/** An agent session was started in a test mode that has no script for it. */
export class UnscriptedAgentError extends Error {}

export interface TestModeAgentBackend extends AgentBackend {
  /**
   * Resolves once no session has anything left to play for now (every turn has ended or is waiting for Stop, including
   * the turns the agent has yet to start on its own), and the runner has handled what they streamed.
   */
  whenIdle(): Promise<void>
}

/** The scripts a test mode's sessions play. */
export interface TestModeScripts {
  /** What a session plays unless its first message picks another. */
  readonly script: AgentScript | null
  /** The script a session plays when its first message is exactly the key. */
  readonly byFirstMessage?: ReadonlyMap<string, AgentScript>
  /**
   * The first message of the task whose SDK session is the one given, if there is one: what a resumed session picks
   * its script by, in place of the first message it's sent.
   */
  readonly firstMessageOf?: (sessionId: string) => string | undefined
  /**
   * Hears the content of every message a session is sent, as the SDK backend would hand it to the agent: its text, or
   * its image content blocks then its text. E2e mode records it for a spec to read (`E2E_AGENT_GLOBAL`).
   */
  readonly onSent?: (content: UserContent) => void
}

/** The environment the sessions' agent processes would run in, as the real backend has it (`SdkBackendOptions`). */
export interface TestModeEnvironment {
  readonly env: Promise<Environment>
  /** Told, once it's known, the environment each session started would have run in, in the order they started. */
  readonly onSessionEnv: (env: Environment) => void
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
export function createTestModeAgentBackend(
  scripts: TestModeScripts,
  environment?: TestModeEnvironment,
  log: Logger = SILENT_LOGGER,
): TestModeAgentBackend {
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
        log.error('no agent script for a session', { cwd: options.cwd, error })
        throw error
      }
      const { cwd, model, effort, resumeSessionId } = options
      ;(options.log ?? log).info('scripted agent starting', { cwd, model, effort, resumeSessionId })
      if (environment !== undefined) void environment.env.then(environment.onSessionEnv)
      const choose = chooser(scripts)
      const resumedFirst = resumeSessionId === null ? undefined : scripts.firstMessageOf?.(resumeSessionId)
      const script: ScriptChooser = resumedFirst === undefined ? choose : () => choose(resumedFirst)
      // A turn the agent starts on its own keeps the session busy, like a message sent.
      const session = new ScriptedSession({
        script,
        session: options,
        onIdle: settle,
        onWake: () => {
          busy += 1
        },
      })
      return {
        messages: session.messages,
        send(text, uuid, images) {
          busy += 1
          scripts.onSent?.(userContent(text, images))
          session.send(text, uuid)
        },
        configure: (settings) => {
          session.configure(settings)
        },
        interrupt: () => session.interrupt(),
        stopTask: (sdkTaskId) => session.stopTask(sdkTaskId),
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
