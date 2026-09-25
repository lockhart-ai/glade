import { describe, expect, it } from 'vitest'
import { foregroundGroup, isRunningProgram, processName } from './foreground'

describe('foregroundGroup', () => {
  it('reads the foreground process group from ps', () => {
    expect(foregroundGroup('  4821\n')).toBe(4821)
  })

  it('finds none when the terminal has no foreground group, or the shell is gone', () => {
    expect(foregroundGroup('   -1\n')).toBeNull()
    expect(foregroundGroup('')).toBeNull()
    expect(foregroundGroup('0')).toBeNull()
  })
})

describe('isRunningProgram', () => {
  it('is false while the shell itself is in the foreground, at its prompt', () => {
    expect(isRunningProgram('zsh', 'zsh')).toBe(false)
    expect(isRunningProgram('-zsh', 'zsh')).toBe(false)
    expect(isRunningProgram('/bin/zsh', 'zsh')).toBe(false)
  })

  it('is true while another program is', () => {
    expect(isRunningProgram('python3.12', 'zsh')).toBe(true)
    expect(isRunningProgram('bash', 'zsh')).toBe(true)
  })

  it('is false when the terminal can’t say', () => {
    expect(isRunningProgram('', 'zsh')).toBe(false)
  })
})

describe('processName', () => {
  it('is the command’s name, without a login shell’s dash or the path it was started from', () => {
    expect(processName('python3')).toBe('python3')
    expect(processName('-zsh')).toBe('zsh')
    expect(processName('/bin/bash')).toBe('bash')
  })
})
