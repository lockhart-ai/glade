// The reasons the error card words (`src/shared/startupFailure.ts`) against the SDK's own list, so an SDK upgrade that
// adds or renames one fails the typecheck here.
import type { SDKStartupFailureReason } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'vitest'
import { isStartupFailureReason, StartupFailureReason, startupFailureMessage } from '../../shared/startupFailure'

/** Each of the SDK's reasons, which must be one of Glade's. */
const SDK_REASONS: Readonly<Record<SDKStartupFailureReason, StartupFailureReason>> = {
  org_pin_api_key_conflict: StartupFailureReason.OrgPinApiKeyConflict,
  org_verify_failed: StartupFailureReason.OrgVerifyFailed,
  org_pin_mismatch: StartupFailureReason.OrgPinMismatch,
  managed_settings_invalid: StartupFailureReason.ManagedSettingsInvalid,
  remote_settings_required_unavailable: StartupFailureReason.RemoteSettingsRequiredUnavailable,
  gateway_signin_required: StartupFailureReason.GatewaySigninRequired,
  gateway_access_denied: StartupFailureReason.GatewayAccessDenied,
  proxy_invalid: StartupFailureReason.ProxyInvalid,
  temp_dir_unusable: StartupFailureReason.TempDirUnusable,
  cwd_unavailable: StartupFailureReason.CwdUnavailable,
  shell_tool_missing: StartupFailureReason.ShellToolMissing,
  session_held_by_background: StartupFailureReason.SessionHeldByBackground,
  worktree_resume_refused: StartupFailureReason.WorktreeResumeRefused,
  worktree_unverified: StartupFailureReason.WorktreeUnverified,
  cli_version_too_old: StartupFailureReason.CliVersionTooOld,
  bypass_root: StartupFailureReason.BypassRoot,
}

// And every one of Glade's is one of the SDK's.
const GLADE_REASONS: readonly SDKStartupFailureReason[] = Object.values(StartupFailureReason)

it("knows exactly the SDK's reasons, each by its own name, with a message for each", () => {
  for (const [sdkReason, reason] of Object.entries(SDK_REASONS)) expect(reason).toBe(sdkReason)
  expect([...GLADE_REASONS].sort()).toEqual(Object.keys(SDK_REASONS).sort())
  for (const reason of GLADE_REASONS) {
    expect(isStartupFailureReason(reason)).toBe(true)
    expect(startupFailureMessage(reason)).toEqual(expect.any(String))
  }
})

it('has no message for a reason it does not know', () => {
  expect(isStartupFailureReason('some_new_reason')).toBe(false)
  expect(startupFailureMessage('some_new_reason')).toBeNull()
})
