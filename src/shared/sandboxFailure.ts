/**
 * A sandbox that couldn't start (`docs/sdk-notes.md` §15): the session still runs, but every `Bash` call fails with
 * Claude Code's `Sandbox is required but failed to initialize: <why>. Restart to retry.` (or, for a settings error,
 * `…: <why>. Fix the sandbox settings to retry (…)`). Glade spots it in a call's result to show the task's error.
 */

/** How Claude Code's failure to start the sandbox begins, with `failIfUnavailable` on. */
export const SANDBOX_INIT_FAILURE_PREFIX = 'Sandbox is required but failed to initialize: '

/** What follows the reason: what Claude Code says to do about it. */
const RETRY_ADVICE = /\.?\s*(?:Restart to retry\.?|Fix the sandbox settings to retry\b[\s\S]*)\s*$/

/**
 * Why the sandbox couldn't start, when `output` is Claude Code's failure to start it, e.g. `tlsTerminate: caCertPath
 * and caKeyPath must be provided together`; null for anything else. Only a result that is the failure counts, not one
 * that mentions it later (a file a command printed, say).
 */
export function sandboxFailureReason(output: string): string | null {
  const text = output.trim()
  if (!text.startsWith(SANDBOX_INIT_FAILURE_PREFIX)) return null
  const reason = text.slice(SANDBOX_INIT_FAILURE_PREFIX.length).replace(RETRY_ADVICE, '').trim()
  return reason === '' ? 'no reason given' : reason
}
