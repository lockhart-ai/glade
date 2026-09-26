/**
 * Why Claude Code couldn't start a session, as the SDK names it (`SDKStartupFailureReason`, on the `result` a failed
 * start ends with, `docs/sdk-notes.md` "Errors and retries"), and how the error card says it.
 */

/** The reasons the SDK gives, SDK 0.3.281. A newer SDK may give others: `startupFailureMessage` has a fallback. */
export enum StartupFailureReason {
  OrgPinApiKeyConflict = 'org_pin_api_key_conflict',
  OrgVerifyFailed = 'org_verify_failed',
  OrgPinMismatch = 'org_pin_mismatch',
  ManagedSettingsInvalid = 'managed_settings_invalid',
  RemoteSettingsRequiredUnavailable = 'remote_settings_required_unavailable',
  GatewaySigninRequired = 'gateway_signin_required',
  GatewayAccessDenied = 'gateway_access_denied',
  ProxyInvalid = 'proxy_invalid',
  TempDirUnusable = 'temp_dir_unusable',
  CwdUnavailable = 'cwd_unavailable',
  ShellToolMissing = 'shell_tool_missing',
  SessionHeldByBackground = 'session_held_by_background',
  WorktreeResumeRefused = 'worktree_resume_refused',
  WorktreeUnverified = 'worktree_unverified',
  CliVersionTooOld = 'cli_version_too_old',
  BypassRoot = 'bypass_root',
}

/** What the error card says for each reason: one sentence, in the user's terms. */
const MESSAGES: Readonly<Record<StartupFailureReason, string>> = {
  [StartupFailureReason.OrgPinApiKeyConflict]:
    'Claude Code couldn’t start: its API key belongs to a different organization than the one it’s set to use.',
  [StartupFailureReason.OrgVerifyFailed]: 'Claude Code couldn’t start: it couldn’t verify your organization.',
  [StartupFailureReason.OrgPinMismatch]:
    'Claude Code couldn’t start: you’re logged in to a different organization than the one it’s set to use.',
  [StartupFailureReason.ManagedSettingsInvalid]:
    'Claude Code couldn’t start: your organization’s managed settings are invalid.',
  [StartupFailureReason.RemoteSettingsRequiredUnavailable]:
    'Claude Code couldn’t start: it couldn’t load the settings your organization requires.',
  [StartupFailureReason.GatewaySigninRequired]:
    'Claude Code couldn’t start: your organization’s gateway needs you to sign in again.',
  [StartupFailureReason.GatewayAccessDenied]: 'Claude Code couldn’t start: your organization’s gateway denied access.',
  [StartupFailureReason.ProxyInvalid]: 'Claude Code couldn’t start: its proxy setting is invalid.',
  [StartupFailureReason.TempDirUnusable]: 'Claude Code couldn’t start: it can’t write to the temporary folder.',
  [StartupFailureReason.CwdUnavailable]: 'The workspace folder is missing, so Claude Code couldn’t start in it.',
  [StartupFailureReason.ShellToolMissing]: 'Claude Code couldn’t start: it found no shell to run commands with.',
  [StartupFailureReason.SessionHeldByBackground]:
    'Claude Code couldn’t start: another Claude Code process is still using this session.',
  [StartupFailureReason.WorktreeResumeRefused]:
    'Claude Code couldn’t start: it wouldn’t resume this session in its worktree.',
  [StartupFailureReason.WorktreeUnverified]: 'Claude Code couldn’t start: it couldn’t verify this session’s worktree.',
  [StartupFailureReason.CliVersionTooOld]: 'Claude Code couldn’t start: its version is too old for this session.',
  [StartupFailureReason.BypassRoot]:
    'Claude Code couldn’t start: it won’t allow every tool call without asking when run as root.',
}

const REASONS: ReadonlySet<string> = new Set(Object.values(StartupFailureReason))

/** Whether the SDK's reason is one Glade knows. */
export function isStartupFailureReason(reason: string): reason is StartupFailureReason {
  return REASONS.has(reason)
}

/** What the error card says for a reason the SDK gave; null for one Glade doesn't know. */
export function startupFailureMessage(reason: string): string | null {
  return isStartupFailureReason(reason) ? MESSAGES[reason] : null
}
