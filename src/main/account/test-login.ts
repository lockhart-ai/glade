/**
 * The test modes' stand-ins for Claude Code's login (`./login`): an e2e or capture run never logs anyone in or out, so
 * it never runs the real one.
 */
import { E2E_LOGIN_GLOBAL, type E2eLogin, type E2eLoginOutcome } from '../e2e'
import { LoginOutcomeKind, type LoginOutcome, type LoginRun, type RunLogin } from './login'

/**
 * Puts an `E2eLogin` on the global object for a spec to drive (`E2E_LOGIN_GLOBAL`), and answers with the login e2e
 * mode runs: each run waits until the spec ends it (`finish`), or it's cancelled.
 */
export function createE2eLogin(): RunLogin {
  let runs = 0
  let end: ((outcome: LoginOutcome) => void) | null = null
  const login: E2eLogin = {
    get runs() {
      return runs
    },
    get waiting() {
      return end !== null
    },
    finish(outcome: E2eLoginOutcome) {
      end?.(
        outcome.loggedIn
          ? { kind: LoginOutcomeKind.LoggedIn }
          : { kind: LoginOutcomeKind.Failed, message: outcome.message },
      )
    },
  }
  Reflect.set(globalThis, E2E_LOGIN_GLOBAL, login)
  return () => {
    runs += 1
    let resolve: (outcome: LoginOutcome) => void = () => undefined
    const done = new Promise<LoginOutcome>((settle) => {
      resolve = settle
    })
    const run: LoginRun = {
      done,
      cancel: () => {
        finished({ kind: LoginOutcomeKind.Cancelled })
      },
    }
    const finished = (outcome: LoginOutcome): void => {
      if (end === finished) end = null
      resolve(outcome)
    }
    end = finished
    return run
  }
}

/** The login a capture runs: it waits for good, since a capture only shows a screen and never finishes one. */
export const WAITING_LOGIN: RunLogin = () => ({
  done: new Promise<LoginOutcome>(() => undefined),
  cancel: () => undefined,
})
