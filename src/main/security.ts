/** The webPreferences that must hold for every window, or the app refuses to start. */
export enum SecuritySetting {
  ContextIsolation = 'contextIsolation',
  NodeIntegration = 'nodeIntegration',
  Sandbox = 'sandbox',
}

/** The subset of Electron's `WebPreferences` that the security check reads. */
export interface SecurityPreferences {
  readonly contextIsolation?: boolean | undefined
  readonly nodeIntegration?: boolean | undefined
  readonly sandbox?: boolean | undefined
}

export interface SecurityViolation {
  readonly setting: SecuritySetting
  readonly required: boolean
  readonly actual: boolean | undefined
}

export type SecurityCheck =
  { readonly ok: true } | { readonly ok: false; readonly violations: readonly SecurityViolation[] }

const ALL_SETTINGS: readonly SecuritySetting[] = Object.values(SecuritySetting)

function requiredValue(setting: SecuritySetting): boolean {
  switch (setting) {
    case SecuritySetting.ContextIsolation:
      return true
    case SecuritySetting.NodeIntegration:
      return false
    case SecuritySetting.Sandbox:
      return true
  }
}

function actualValue(preferences: SecurityPreferences, setting: SecuritySetting): boolean | undefined {
  switch (setting) {
    case SecuritySetting.ContextIsolation:
      return preferences.contextIsolation
    case SecuritySetting.NodeIntegration:
      return preferences.nodeIntegration
    case SecuritySetting.Sandbox:
      return preferences.sandbox
  }
}

/**
 * Checks the webPreferences a window will be created with against the required security settings. A setting that is
 * left out counts as a violation, even where Electron's default would be safe: every setting must be stated
 * explicitly.
 */
export function checkSecurity(preferences: SecurityPreferences): SecurityCheck {
  const violations = ALL_SETTINGS.flatMap((setting): SecurityViolation[] => {
    const required = requiredValue(setting)
    const actual = actualValue(preferences, setting)
    return actual === required ? [] : [{ setting, required, actual }]
  })
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

/** A one-line description of each violation, for logs and the startup error dialog. */
export function describeViolations(violations: readonly SecurityViolation[]): string {
  return violations
    .map(({ setting, required, actual }) => `${setting} must be ${String(required)} (was ${String(actual)})`)
    .join('\n')
}
export const ciBreak: number = "not a number";
