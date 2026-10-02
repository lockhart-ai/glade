/**
 * Logging in to Claude from Glade (#409): when Claude Code's login expires or goes, the task it stopped offers Log in,
 * which runs Claude Code's own login (`claude auth login`, from the bundled binary, `docs/sdk-notes.md` §1): it opens
 * Anthropic's sign-in page in the browser and saves the login where Claude Code keeps it. Glade never sees the
 * credential. Main runs it and says how it's going (`login.changed`); the error card and Settings › General show it.
 */
import type { EpochMs } from './domain'

/** Where logging in stands. */
export enum LoginState {
  /** No login running, and none has finished since a task last stopped logged out. */
  Idle = 'idle',
  /** Claude Code's login is running: its sign-in page is open in the browser, waiting for you. */
  Waiting = 'waiting',
  /** The last login succeeded, and no task has stopped logged out since. */
  LoggedIn = 'logged_in',
  /** The last login didn't finish: `message` says why. */
  Failed = 'failed',
}

/** Where logging in stands, with what each state needs. */
export type LoginStatus =
  | { readonly state: LoginState.Idle }
  | {
      readonly state: LoginState.Waiting
      readonly since: EpochMs
      /** The tasks whose Log in was clicked, which are retried once you're logged in. */
      readonly taskIds: readonly string[]
    }
  | { readonly state: LoginState.LoggedIn; readonly at: EpochMs }
  | { readonly state: LoginState.Failed; readonly message: string }

/** No login running, or none yet. */
export const IDLE_LOGIN: LoginStatus = { state: LoginState.Idle }
