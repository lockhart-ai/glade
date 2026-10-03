import { describe, expect, it } from 'vitest'
import { SANDBOX_INIT_FAILURE_PREFIX, sandboxFailureReason } from './sandboxFailure'

describe('sandboxFailureReason', () => {
  it('reads why the sandbox couldn’t start from Claude Code’s message (docs/sdk-notes.md §15)', () => {
    expect(
      sandboxFailureReason(
        'Sandbox is required but failed to initialize: tlsTerminate: caCertPath and caKeyPath must be provided together. Restart to retry.',
      ),
    ).toBe('tlsTerminate: caCertPath and caKeyPath must be provided together')
  })

  it('reads the settings error’s variant, which says to fix the settings instead', () => {
    expect(
      sandboxFailureReason(
        `${SANDBOX_INIT_FAILURE_PREFIX}filesystem.allowWrite: not an absolute path. Fix the sandbox settings to retry (a --settings file is pinned for the process: restart).`,
      ),
    ).toBe('filesystem.allowWrite: not an absolute path')
  })

  it('keeps a reason that spans lines, and copes with the space around it', () => {
    expect(sandboxFailureReason(`\n  ${SANDBOX_INIT_FAILURE_PREFIX}first line\nsecond line. Restart to retry.\n`)).toBe(
      'first line\nsecond line',
    )
  })

  it('keeps a reason with no advice after it, and names a missing one', () => {
    expect(sandboxFailureReason(`${SANDBOX_INIT_FAILURE_PREFIX}seatbelt profile rejected`)).toBe(
      'seatbelt profile rejected',
    )
    expect(sandboxFailureReason(`${SANDBOX_INIT_FAILURE_PREFIX}. Restart to retry.`)).toBe('no reason given')
  })

  it('is null for anything that isn’t the failure itself', () => {
    expect(sandboxFailureReason('Exit code 1\ncat: notes.md: Operation not permitted')).toBeNull()
    expect(
      sandboxFailureReason(`Exit code 1\n${SANDBOX_INIT_FAILURE_PREFIX}printed by a script. Restart to retry.`),
    ).toBeNull()
    expect(sandboxFailureReason('The notes say: Sandbox is required but failed to initialize: x.')).toBeNull()
    expect(sandboxFailureReason('')).toBeNull()
  })
})
