import { describe, expect, it } from 'vitest'
import { checkSecurity, describeViolations, SecuritySetting, type SecurityPreferences } from './security'

const SECURE: SecurityPreferences = { contextIsolation: true, nodeIntegration: false, sandbox: true }

describe('checkSecurity', () => {
  it('passes when every setting holds', () => {
    expect(checkSecurity(SECURE)).toEqual({ ok: true })
  })

  it.each([
    [SecuritySetting.ContextIsolation, { contextIsolation: false }, true, false],
    [SecuritySetting.NodeIntegration, { nodeIntegration: true }, false, true],
    [SecuritySetting.Sandbox, { sandbox: false }, true, false],
  ] as const)('reports %s when it has the wrong value', (setting, override, required, actual) => {
    expect(checkSecurity({ ...SECURE, ...override })).toEqual({
      ok: false,
      violations: [{ setting, required, actual }],
    })
  })

  it.each([SecuritySetting.ContextIsolation, SecuritySetting.NodeIntegration, SecuritySetting.Sandbox])(
    'reports %s when it is left out',
    (setting) => {
      const preferences: SecurityPreferences = { ...SECURE, [setting]: undefined }
      const result = checkSecurity(preferences)
      expect(result.ok).toBe(false)
      expect(result.ok ? [] : result.violations).toEqual([
        { setting, required: setting !== SecuritySetting.NodeIntegration, actual: undefined },
      ])
    },
  )

  it('reports every violation, in setting order', () => {
    expect(checkSecurity({})).toEqual({
      ok: false,
      violations: [
        { setting: SecuritySetting.ContextIsolation, required: true, actual: undefined },
        { setting: SecuritySetting.NodeIntegration, required: false, actual: undefined },
        { setting: SecuritySetting.Sandbox, required: true, actual: undefined },
      ],
    })
  })
})

describe('describeViolations', () => {
  it('describes each violation on its own line', () => {
    expect(
      describeViolations([
        { setting: SecuritySetting.ContextIsolation, required: true, actual: false },
        { setting: SecuritySetting.NodeIntegration, required: false, actual: undefined },
      ]),
    ).toBe('contextIsolation must be true (was false)\nnodeIntegration must be false (was undefined)')
  })

  it('is empty when there are no violations', () => {
    expect(describeViolations([])).toBe('')
  })
})
