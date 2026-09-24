/** The webPreferences that must hold for every window, or the app refuses to start. */
export enum SecuritySetting {
  ContextIsolation = 'contextIsolation',
  NodeIntegration = 'nodeIntegration',
  Sandbox = 'sandbox',
}

/** The subset of Electron's resolved `WebPreferences` that the security check reads. */
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
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly SecurityViolation[] }

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

function readBoolean(record: object, key: SecuritySetting): boolean | undefined {
  const value: unknown = Reflect.get(record, key)
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Parses the resolved webPreferences Electron reports for a window. Anything that isn't a boolean is read as missing,
 * so a malformed or absent value fails the check rather than passing it.
 */
export function parseSecurityPreferences(value: unknown): SecurityPreferences {
  if (typeof value !== 'object' || value === null) return {}
  return {
    contextIsolation: readBoolean(value, SecuritySetting.ContextIsolation),
    nodeIntegration: readBoolean(value, SecuritySetting.NodeIntegration),
    sandbox: readBoolean(value, SecuritySetting.Sandbox),
  }
}

/**
 * Checks a window's resolved webPreferences against the required security settings. A setting that is missing
 * counts as a violation: the check only passes when every setting is explicitly in effect.
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
